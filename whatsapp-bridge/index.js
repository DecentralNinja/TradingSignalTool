// Self-hosted WhatsApp bridge using Baileys (unofficial multi-device protocol
// client). Links to a real WhatsApp account by QR scan, then exposes a tiny
// HTTP endpoint the Lambda fetch cycle calls to send alert messages to that
// same account's own chat (self-chat) -- no third party ever sees the
// messages, since this runs entirely on infrastructure we control. Must stay
// running persistently (holds a live WebSocket connection to WhatsApp), so
// this is not deployable as a Lambda -- runs on a small always-on VM instead.
require('dotenv').config()
const fs = require('fs')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const qrcode = require('qrcode-terminal')
const express = require('express')
const pino = require('pino')

const PORT = process.env.PORT || 3000
const BRIDGE_SECRET = process.env.BRIDGE_SECRET
const CHANNEL_NAME = process.env.CHANNEL_NAME || 'BTC Signal Alerts'
const CHANNEL_FILE = './channel.json'

if (!BRIDGE_SECRET) {
  console.error('BRIDGE_SECRET env var is required.')
  process.exit(1)
}

let sock = null
let isReady = false
let channelJid = fs.existsSync(CHANNEL_FILE) ? JSON.parse(fs.readFileSync(CHANNEL_FILE, 'utf8')).jid : null

// Creates the alerts channel once (persisted to CHANNEL_FILE) and follows it
// so it shows up under WhatsApp's Updates tab -- kept separate from personal
// chats/self-notes, unlike posting to self-chat.
async function ensureChannel() {
  if (channelJid) return
  const metadata = await sock.newsletterCreate(CHANNEL_NAME, 'Automated BTC trading signal alerts')
  channelJid = metadata.id
  await sock.newsletterFollow(channelJid)
  fs.writeFileSync(CHANNEL_FILE, JSON.stringify({ jid: channelJid, name: CHANNEL_NAME }))
  console.log(`Created and followed channel "${CHANNEL_NAME}" (${channelJid})`)
}

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
      ensureChannel().catch((err) => console.error('Channel setup failed:', err.message))
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
  if (!channelJid) {
    return res.status(503).json({ error: 'channel not set up yet' })
  }
  const { message } = req.body
  if (!message) {
    return res.status(400).json({ error: 'message is required' })
  }

  try {
    await sock.sendMessage(channelJid, { text: message })
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
