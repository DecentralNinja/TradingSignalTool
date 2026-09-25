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
// Base USD notional for a "Full size" (100%) trade. Reduced/Standard combos
// scale down from here via the signal's own position_size_pct.
const BASE_TRADE_USD = Number(process.env.BASE_TRADE_USD || 1000)

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

    const direction = signal.signal === 'bullish' ? 'long' : 'short'
    const snapshot = await db.getLatestSnapshot()
    const entryPrice = snapshot?.mark_price
    if (!entryPrice) return res.status(503).json({ error: 'no current price available' })

    const notionalUsd = (BASE_TRADE_USD * (signal.position_size_pct || 100)) / 100
    const qty = Number((notionalUsd / entryPrice).toFixed(3))

    const trade = await db.insertTrade({
      signal_id: signal.id,
      symbol: 'BTCUSDT',
      direction,
      status: 'open',
      is_demo: bitget.IS_DEMO,
      position_size_pct: signal.position_size_pct,
      margin_usd: notionalUsd,
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

    const snapshot = await db.getLatestSnapshot()
    const exitPrice = snapshot?.mark_price
    const priceChangePct = exitPrice ? ((exitPrice - trade.entry_price) / trade.entry_price) * 100 : null
    const pnlPct = priceChangePct != null ? (trade.direction === 'long' ? priceChangePct : -priceChangePct) : null
    const pnlUsd = pnlPct != null ? (trade.margin_usd * pnlPct) / 100 : null

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

app.listen(PORT, () => {
  console.log(`Bridge HTTP server listening on port ${PORT}`)
})
