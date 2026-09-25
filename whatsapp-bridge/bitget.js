// Minimal Bitget UTA v3 REST client -- just enough to open a futures
// position with an attached TP/SL, and to reduce-only close one.
// Demo trading uses the SAME base URL and endpoints as real trading; the
// only difference is the `paptrading: 1` header plus using a Demo API key.
const crypto = require('crypto')

const BASE_URL = 'https://api.bitget.com'

const API_KEY = process.env.BITGET_API_KEY
const API_SECRET = process.env.BITGET_API_SECRET
const API_PASSPHRASE = process.env.BITGET_API_PASSPHRASE
const IS_DEMO = process.env.BITGET_DEMO !== 'false' // default to demo unless explicitly turned off

function sign(timestamp, method, requestPath, body) {
  const prehash = timestamp + method.toUpperCase() + requestPath + (body ? JSON.stringify(body) : '')
  return crypto.createHmac('sha256', API_SECRET).update(prehash).digest('base64')
}

async function bitgetRequest(method, path, { query = '', body = null } = {}) {
  if (!API_KEY || !API_SECRET || !API_PASSPHRASE) {
    throw new Error('Bitget API credentials are not configured')
  }
  const timestamp = Date.now().toString()
  const requestPath = query ? `${path}?${query}` : path
  const signature = sign(timestamp, method, requestPath, body)

  const headers = {
    'ACCESS-KEY': API_KEY,
    'ACCESS-SIGN': signature,
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': API_PASSPHRASE,
    'Content-Type': 'application/json',
  }
  if (IS_DEMO) headers['paptrading'] = '1'

  const res = await fetch(BASE_URL + requestPath, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  if (json.code && json.code !== '00000') {
    throw new Error(`Bitget API error ${json.code}: ${json.msg}`)
  }
  return json.data
}

// direction: 'long' | 'short'. qty is the base-coin BTC size.
// posSide is required when the account is in hedge-mode (Bitget error 25236
// "Incorrect position open type" otherwise) -- it always names the position
// side being affected, independent of the buy/sell order action itself.
async function openPosition({ symbol, direction, qty, stopLossPrice, takeProfitPrice }) {
  const body = {
    category: 'USDT-FUTURES',
    symbol,
    side: direction === 'long' ? 'buy' : 'sell',
    posSide: direction,
    orderType: 'market',
    qty: String(qty),
    marginMode: 'crossed',
    stopLoss: String(stopLossPrice),
    takeProfit: String(takeProfitPrice),
    slTriggerBy: 'mark',
    tpTriggerBy: 'mark',
  }
  return bitgetRequest('POST', '/api/v3/trade/place-order', { body })
}

// Reduce-only close: closing a long is a sell, closing a short is a buy.
async function closePosition({ symbol, direction, qty }) {
  const body = {
    category: 'USDT-FUTURES',
    symbol,
    side: direction === 'long' ? 'sell' : 'buy',
    posSide: direction,
    orderType: 'market',
    qty: String(qty),
    marginMode: 'crossed',
    reduceOnly: 'yes',
  }
  return bitgetRequest('POST', '/api/v3/trade/place-order', { body })
}

async function getPosition({ symbol }) {
  const query = `category=USDT-FUTURES&symbol=${symbol}`
  const data = await bitgetRequest('GET', '/api/v3/position/single-position', { query })
  return Array.isArray(data) ? data[0] : data
}

module.exports = { openPosition, closePosition, getPosition, IS_DEMO }
