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
      await db.updateTrade(trade.id, { bitget_order_id: order?.orderId || null })
      res.json({ ok: true, trade: { ...trade, bitget_order_id: order?.orderId } })
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

    await bitget.closePosition({ symbol: trade.symbol, direction: trade.direction, qty: trade.qty })

    // Read back the fill we just caused to get the real exit price/PnL
    // (fees included) instead of approximating from our own price feed.
    const fills = await bitget.getFills({ symbol: trade.symbol })
    const closingFill = fills.find(
      (f) => f.posSide === trade.direction && f.tradeSide?.startsWith('close_')
    )
    const exitPrice = closingFill ? Number(closingFill.execPrice) : null
    const pnlUsd = closingFill ? Number(closingFill.execPnl) : null
    const pnlPct = pnlUsd != null && trade.margin_usd ? (pnlUsd / trade.margin_usd) * 100 : null

    const updated = await db.updateTrade(trade.id, {
      status: 'closed_manual',
      exit_price: exitPrice,
      pnl_pct: pnlPct,
      pnl_usd: pnlUsd,
      closed_at: new Date().toISOString(),
    })
    res.json({ ok: true, trade: updated })
  } catch (err) {
    console.error('Trade close failed:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Bitget's own exchange-side TP/SL can close a position at any moment,
// independent of this server or the dashboard being open at all (that's the
// whole point of putting the stop-loss on the exchange, not in our code).
// This polls every 45s so the trades table -- and the dashboard -- catch up
// with reality instead of showing a trade as "open" forever after that.
async function reconcileOpenTrades() {
  let openTrades
  try {
    openTrades = await db.getOpenTrades()
  } catch (err) {
    console.error('Reconcile: failed to load open trades:', err.message)
    return
  }
  if (!openTrades.length) return

  const bySymbol = {}
  for (const trade of openTrades) {
    bySymbol[trade.symbol] = bySymbol[trade.symbol] || []
    bySymbol[trade.symbol].push(trade)
  }

  for (const [symbol, trades] of Object.entries(bySymbol)) {
    let positions
    try {
      positions = await bitget.getPositions({ symbol })
    } catch (err) {
      console.error(`Reconcile: failed to fetch ${symbol} positions:`, err.message)
      continue
    }

    for (const trade of trades) {
      // A closed position simply stops appearing in this list at all -- more
      // reliable than trusting an exact size-field name we haven't verified
      // against a live response (Bitget's docs didn't confirm it cleanly).
      const stillOpen = positions.some((p) => (p.posSide || p.holdSide) === trade.direction)
      if (stillOpen) continue

      try {
        // Pull the exact closing fill from Bitget rather than approximating
        // from our own live price feed, which drifts from the real close
        // price the longer this poll takes to catch it.
        const fills = await bitget.getFills({ symbol })
        const openedAtMs = new Date(trade.opened_at).getTime()
        const closingFill = fills.find(
          (f) =>
            f.posSide === trade.direction &&
            f.tradeSide?.startsWith('close_') &&
            Number(f.createdTime) >= openedAtMs
        )

        const exitPrice = closingFill ? Number(closingFill.execPrice) : null
        const pnlUsd = closingFill ? Number(closingFill.execPnl) : null
        const pnlPct = pnlUsd != null && trade.margin_usd ? (pnlUsd / trade.margin_usd) * 100 : null

        await db.updateTrade(trade.id, {
          status: pnlUsd != null && pnlUsd >= 0 ? 'closed_won' : 'closed_lost',
          exit_price: exitPrice,
          pnl_pct: pnlPct,
          pnl_usd: pnlUsd,
          closed_at: new Date().toISOString(),
        })
        console.log(`Reconciled trade ${trade.id}: closed on Bitget's side (TP/SL hit)`)
      } catch (err) {
        console.error(`Reconcile: failed to update trade ${trade.id}:`, err.message)
      }
    }
  }
}

setInterval(() => reconcileOpenTrades().catch((err) => console.error('Reconcile failed:', err.message)), 45000)

app.listen(PORT, () => {
  console.log(`Bridge HTTP server listening on port ${PORT}`)
})
