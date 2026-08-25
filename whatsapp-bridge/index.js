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

const PORT = process.env.PORT || 3000
const BRIDGE_SECRET = process.env.BRIDGE_SECRET
const CHANNEL_JID = process.env.CHANNEL_JID // e.g. 120363412044603667@newsletter

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

app.listen(PORT, () => {
  console.log(`Bridge HTTP server listening on port ${PORT}`)
})
