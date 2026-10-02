// Self-hosted WhatsApp bridge using Baileys (unofficial multi-device protocol
// client). Links to a real WhatsApp account by QR scan, then exposes a tiny
// HTTP endpoint the Lambda fetch cycle calls to post alert messages to the
// BTC Signal Alerts channel. Linked to a DIFFERENT account than the
// recipient on purpose -- WhatsApp doesn't push notifications for content
// sent from your own linked devices or your own channel (confirmed by
// direct testing), so a genuinely separate account has to be the one
// posting for a real notification to fire. That separate account must be
// promoted to admin on the channel first (via WhatsApp's own UI -- Baileys
// has no API to do this) before it can post here. Must stay running
// persistently (holds a live WebSocket connection to WhatsApp), so this is
// not deployable as a Lambda -- runs on a small always-on VM instead.
require('dotenv').config()
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const qrcode = require('qrcode-terminal')
const express = require('express')
const pino = require('pino')
const bitget = require('./bitget')
const db = require('./supabase')

const PORT = process.env.PORT || 3000
const BRIDGE_SECRET = process.env.BRIDGE_SECRET
const CHANNEL_JID = process.env.CHANNEL_JID // e.g. 120363412044603667@newsletter

// Position sizing is a % of the account's REAL balance put up as margin, not
// a flat guessed dollar amount -- a "Full size" (100%) signal risks
// MAX_MARGIN_PCT of the account, "Standard" (75%) and "Reduced" (50%) scale
// down from there via the signal's own position_size_pct. Leverage then
// multiplies that margin into the actual position size.
const MAX_MARGIN_PCT = Number(process.env.MAX_MARGIN_PCT || 20) // Full-size trade risks this % of account equity
const LEVERAGE = Number(process.env.BITGET_LEVERAGE || 15)
// Max trades open at once. One setup often re-alerts several times within an
// hour (3 alerts in 90min on 2026-10-01), and taking them all stacks that many
// times the exposure on a single move. A risk cap, not a backtested edge.
const MAX_OPEN_TRADES = Number(process.env.MAX_OPEN_TRADES || 2)

if (!BRIDGE_SECRET || !CHANNEL_JID) {
  console.error('BRIDGE_SECRET and CHANNEL_JID env vars are required.')
  process.exit(1)
}

const targetJid = CHANNEL_JID
let sock = null
let isReady = false

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('\nScan this QR code with WhatsApp (Linked Devices > Link a Device):\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
      isReady = true
      console.log('WhatsApp bridge connected.')
    }

    if (connection === 'close') {
      isReady = false
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut
      console.error(`Connection closed (status ${statusCode}). Logged out: ${loggedOut}`)
      if (!loggedOut) {
        console.log('Reconnecting...')
        startSocket()
      } else {
        console.error('Logged out -- delete ./auth_info and restart to re-link via QR code.')
      }
    }
  })
}

startSocket()

const app = express()
app.use(express.json())

// The dashboard (Vercel, a different origin) calls /trade/* directly from
// the browser, so it needs an explicit CORS allowance -- only for that
// route, everything still requires a valid Supabase session on top of this.
const DASHBOARD_ORIGIN = process.env.DASHBOARD_URL
app.use((req, res, next) => {
  if (DASHBOARD_ORIGIN) {
    res.header('Access-Control-Allow-Origin', DASHBOARD_ORIGIN)
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.post('/send', async (req, res) => {
  if (req.get('x-bridge-secret') !== BRIDGE_SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  if (!isReady || !sock) {
    return res.status(503).json({ error: 'whatsapp not connected' })
  }
  const { message } = req.body
  if (!message) {
    return res.status(400).json({ error: 'message is required' })
  }

  try {
    await sock.sendMessage(targetJid, { text: message })
    res.json({ ok: true })
  } catch (err) {
    console.error('Send failed:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/health', (req, res) => {
  res.json({ connected: isReady })
})

// Only the logged-in owner (Supabase Auth session from the dashboard) may
// open or close trades. The dashboard sends its Supabase access token as a
// normal Bearer token; we verify it directly against Supabase Auth.
async function requireOwner(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer /, '')
  const user = await db.verifyUser(token)
  if (!user) return res.status(401).json({ error: 'unauthorized' })
  req.user = user
  next()
}

app.post('/trade/open', requireOwner, async (req, res) => {
  const { signalId } = req.body
  if (!signalId) return res.status(400).json({ error: 'signalId is required' })

  try {
    const signal = await db.getSignal(signalId)
    if (!signal) return res.status(404).json({ error: 'signal not found' })
    if (signal.signal === 'neutral') return res.status(400).json({ error: 'signal is neutral, nothing to trade' })

    // Signals go stale -- exit_by_hours is how long the setup is meant to
    // stay valid. Past that, the TP/SL levels no longer relate to where
    // price actually is (Bitget itself rejects a TP that's already been
    // passed), so refuse with a clear reason instead of a raw exchange error.
    if (signal.exit_by_hours) {
      const ageHours = (Date.now() - new Date(signal.evaluated_at).getTime()) / (1000 * 60 * 60)
      if (ageHours > signal.exit_by_hours) {
        return res.status(400).json({
          error: `This signal expired ${(ageHours - signal.exit_by_hours).toFixed(1)}h ago -- its price target is no longer valid. Wait for a fresh signal.`,
        })
      }
    }

    const openTrades = await db.getOpenTrades()
    if (openTrades.length >= MAX_OPEN_TRADES) {
      return res.status(400).json({
        error: `You already have ${openTrades.length} open trade(s) -- the limit is ${MAX_OPEN_TRADES}. Close one before taking another.`,
      })
    }

    const direction = signal.signal === 'bullish' ? 'long' : 'short'
    const snapshot = await db.getLatestSnapshot()
    const entryPrice = snapshot?.mark_price
    if (!entryPrice) return res.status(503).json({ error: 'no current price available' })

    // Margin risked = a % of the REAL account balance (a "Full size" 100%
    // signal risks MAX_MARGIN_PCT, Standard/Reduced scale down from there).
    // Leverage then multiplies that margin into the actual position size --
    // this keeps the amount at risk tied to your real balance regardless of
    // what leverage is set, and comfortably clears Bitget's ~$84 minimum
    // order size at any of these tiers.
    const balance = await bitget.getAccountBalance()
    const marginPct = (MAX_MARGIN_PCT * (signal.position_size_pct || 100)) / 100
    const marginUsd = (balance * marginPct) / 100
    const notionalUsd = marginUsd * LEVERAGE
    const qty = Number((notionalUsd / entryPrice).toFixed(3))
    if (qty <= 0) return res.status(400).json({ error: 'computed position size rounds to zero' })

    await bitget.setLeverage({ symbol: 'BTCUSDT', leverage: LEVERAGE })

    const trade = await db.insertTrade({
      signal_id: signal.id,
      symbol: 'BTCUSDT',
      direction,
      status: 'open',
      is_demo: bitget.IS_DEMO,
      position_size_pct: signal.position_size_pct,
      margin_usd: marginUsd,
      qty,
      entry_price: entryPrice,
      stop_loss_price: signal.stop_loss_price,
      take_profit_price: signal.take_profit_price,
      opened_at: new Date().toISOString(),
    })

    try {
      const order = await bitget.openPosition({
        symbol: 'BTCUSDT',
        direction,
        qty,
        stopLossPrice: signal.stop_loss_price,
        takeProfitPrice: signal.take_profit_price,
      })
      // Replace the snapshot-price estimate with the order's real average
      // fill -- PnL is computed from this per trade later, and the snapshot
      // can be up to 15min stale (was off by ~$100-230 on real trades).
      const patch = { bitget_order_id: order?.orderId || null }
      try {
        const filled = order?.orderId ? await bitget.getOrder({ orderId: order.orderId }) : null
        if (Number(filled?.avgPrice) > 0) patch.entry_price = Number(filled.avgPrice)
      } catch (err) {
        console.error(`Trade ${trade.id}: could not read entry fill, keeping estimate:`, err.message)
      }
      await db.updateTrade(trade.id, patch)
      res.json({ ok: true, trade: { ...trade, ...patch } })
    } catch (err) {
      await db.updateTrade(trade.id, { status: 'failed', error_message: err.message })
      throw err
    }
  } catch (err) {
    console.error('Trade open failed:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/trade/close', requireOwner, async (req, res) => {
  const { tradeId } = req.body
  if (!tradeId) return res.status(400).json({ error: 'tradeId is required' })

  try {
    const trade = await db.getTrade(tradeId)
    if (!trade) return res.status(404).json({ error: 'trade not found' })
    if (trade.status !== 'open') return res.status(400).json({ error: `trade is already ${trade.status}` })

    const order = await bitget.closePosition({ symbol: trade.symbol, direction: trade.direction, qty: trade.qty })

    // Read back the exact order we just placed for the real exit price,
    // rather than "latest close fill", which may belong to another trade.
    let exitPrice = null
    try {
      const filled = order?.orderId ? await bitget.getOrder({ orderId: order.orderId }) : null
      if (Number(filled?.avgPrice) > 0) exitPrice = Number(filled.avgPrice)
    } catch (err) {
      console.error(`Trade ${trade.id}: could not read exit fill:`, err.message)
    }

    const updated = await db.updateTrade(trade.id, {
      status: 'closed_manual',
      exit_price: exitPrice,
      ...tradePnl(trade, exitPrice),
      closed_at: new Date().toISOString(),
    })
    res.json({ ok: true, trade: updated })
  } catch (err) {
    console.error('Trade close failed:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Gross PnL of one trade from its OWN entry, not Bitget's execPnl -- in hedge
// mode every trade on the same side merges into one position, and Bitget
// computes execPnl against that blended avgPrice, which misattributes profit
// between trades (a stopped-out loser showed -$0.51 instead of its real -$4.12).
function tradePnl(trade, exitPrice) {
  if (exitPrice == null || !trade.entry_price) return { pnl_usd: null, pnl_pct: null }
  const sign = trade.direction === 'long' ? 1 : -1
  const pnlUsd = (exitPrice - Number(trade.entry_price)) * Number(trade.qty) * sign
  const pnlPct = trade.margin_usd ? (pnlUsd / Number(trade.margin_usd)) * 100 : null
  return { pnl_usd: pnlUsd, pnl_pct: pnlPct }
}

// Bitget's own exchange-side TP/SL can close a trade at any moment,
// independent of this server or the dashboard being open at all (that's the
// whole point of putting the stop-loss on the exchange, not in our code).
// This polls every 45s so the trades table -- and the dashboard -- catch up
// with reality instead of showing a trade as "open" forever after that.
//
// Hedge mode merges every trade on the same side into ONE position, so "the
// position disappeared" only catches the last trade to close. Instead:
// compare the position's real size with the open trades' combined qty, and
// if some is missing, attribute each exchange-triggered close order to the
// trade whose own TP/SL level it filled nearest to. Each trade's TP/SL is
// its own exchange order with its own trigger price, so that match is
// unambiguous in practice.
const QTY_EPSILON = 1e-9

async function reconcileOpenTrades() {
  let openTrades
  try {
    openTrades = await db.getOpenTrades()
  } catch (err) {
    console.error('Reconcile: failed to load open trades:', err.message)
    return
  }
  if (!openTrades.length) return

  const groups = {}
  for (const trade of openTrades) {
    const key = `${trade.symbol}:${trade.direction}`
    groups[key] = groups[key] || []
    groups[key].push(trade)
  }

  for (const [key, trades] of Object.entries(groups)) {
    const [symbol, direction] = key.split(':')
    let positions, orders
    try {
      positions = await bitget.getPositions({ symbol })
      orders = await bitget.getOrderHistory({ symbol })
    } catch (err) {
      console.error(`Reconcile: failed to fetch ${symbol} state:`, err.message)
      continue
    }

    const position = positions.find((p) => (p.posSide || p.holdSide) === direction)
    const positionQty = position ? Number(position.total) : 0
    const openQty = trades.reduce((sum, t) => sum + Number(t.qty), 0)
    let missingQty = openQty - positionQty
    if (missingQty <= QTY_EPSILON) continue

    // Exchange-triggered closes on this side: closing a long is a sell,
    // closing a short is a buy; delegateType 'market' is an order we placed.
    const closeSide = direction === 'long' ? 'sell' : 'buy'
    const triggeredCloses = orders.filter(
      (o) =>
        o.posSide === direction &&
        o.side === closeSide &&
        o.orderStatus === 'filled' &&
        o.delegateType &&
        o.delegateType !== 'market'
    )

    const unmatched = [...trades]
    for (const order of triggeredCloses) {
      if (missingQty <= QTY_EPSILON) break
      const orderQty = Number(order.cumExecQty || order.qty)
      const exitPrice = Number(order.avgPrice)
      const candidates = unmatched.filter(
        (t) => Math.abs(Number(t.qty) - orderQty) <= QTY_EPSILON && Number(order.createdTime) >= new Date(t.opened_at).getTime()
      )
      if (!candidates.length) continue

      const distance = (t) =>
        Math.min(
          ...[t.stop_loss_price, t.take_profit_price].filter((p) => p != null).map((p) => Math.abs(Number(p) - exitPrice))
        )
      const trade = candidates.reduce((best, t) => (distance(t) < distance(best) ? t : best))
      unmatched.splice(unmatched.indexOf(trade), 1)
      missingQty -= orderQty

      const pnl = tradePnl(trade, exitPrice)
      try {
        await db.updateTrade(trade.id, {
          status: pnl.pnl_usd != null && pnl.pnl_usd >= 0 ? 'closed_won' : 'closed_lost',
          exit_price: exitPrice,
          ...pnl,
          closed_at: new Date(Number(order.createdTime)).toISOString(),
        })
        console.log(`Reconciled trade ${trade.id}: closed on Bitget's side (${order.delegateType} @ ${exitPrice})`)
      } catch (err) {
        console.error(`Reconcile: failed to update trade ${trade.id}:`, err.message)
      }
    }

    // Position fully gone but some trades had no identifiable close order
    // (e.g. closed by hand in Bitget's own app) -- still closed, outcome unknown.
    if (positionQty <= QTY_EPSILON) {
      for (const trade of unmatched) {
        try {
          await db.updateTrade(trade.id, {
            status: 'closed_manual',
            error_message: 'Position closed on Bitget, but no matching close order was found',
            closed_at: new Date().toISOString(),
          })
          console.log(`Reconciled trade ${trade.id}: position gone, close order not identified`)
        } catch (err) {
          console.error(`Reconcile: failed to update trade ${trade.id}:`, err.message)
        }
      }
    }
  }
}

setInterval(() => reconcileOpenTrades().catch((err) => console.error('Reconcile failed:', err.message)), 45000)

app.listen(PORT, () => {
  console.log(`Bridge HTTP server listening on port ${PORT}`)
})
