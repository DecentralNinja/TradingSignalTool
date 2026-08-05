import { withRetry } from './retry.js'

const BASE = 'https://api.bybit.com'

async function fetchJson(url) {
  return withRetry(async () => {
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`${url} failed: ${res.status} ${await res.text()}`)
    }
    const body = await res.json()
    if (body.retCode !== 0) {
      throw new Error(`${url} failed: retCode ${body.retCode} ${body.retMsg}`)
    }
    return body.result
  })
}

// Mark price, funding rate, and open interest all come back in a single call.
export async function getTicker(symbol) {
  const { list } = await fetchJson(`${BASE}/v5/market/tickers?category=linear&symbol=${symbol}`)
  const data = list[0]
  return {
    markPrice: Number(data.markPrice),
    fundingRate: Number(data.fundingRate),
    nextFundingTime: Number(data.nextFundingTime),
    openInterest: Number(data.openInterest),
  }
}

export async function getLongShortRatio(symbol) {
  const { list } = await fetchJson(
    `${BASE}/v5/market/account-ratio?category=linear&symbol=${symbol}&period=15min&limit=1`
  )
  const data = list[0]
  const longAccountRatio = Number(data.buyRatio)
  const shortAccountRatio = Number(data.sellRatio)
  return {
    longAccountRatio,
    shortAccountRatio,
    longShortRatio: longAccountRatio / shortAccountRatio,
  }
}
