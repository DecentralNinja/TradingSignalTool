import { withRetry } from './retry.js'

const BASE = 'https://api.bybit.com'

// Bybit's "list" is normally one element for a single-symbol query; the empty
// check runs inside the retry loop so a transient empty response gets retried
// instead of crashing on undefined access.
async function fetchFirst(url) {
  return withRetry(async () => {
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`${url} failed: ${res.status} ${await res.text()}`)
    }
    const body = await res.json()
    if (body.retCode !== 0) {
      throw new Error(`${url} failed: retCode ${body.retCode} ${body.retMsg}`)
    }
    const { list } = body.result
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`${url} returned no data: ${JSON.stringify(body.result)}`)
    }
    return list[0]
  })
}

// Mark price, funding rate, and open interest all come back in a single call.
export async function getTicker(symbol) {
  const data = await fetchFirst(`${BASE}/v5/market/tickers?category=linear&symbol=${symbol}`)
  return {
    markPrice: Number(data.markPrice),
    fundingRate: Number(data.fundingRate),
    nextFundingTime: Number(data.nextFundingTime),
    openInterest: Number(data.openInterest),
  }
}

export async function getLongShortRatio(symbol) {
  const data = await fetchFirst(
    `${BASE}/v5/market/account-ratio?category=linear&symbol=${symbol}&period=15min&limit=1`
  )
  const longAccountRatio = Number(data.buyRatio)
  const shortAccountRatio = Number(data.sellRatio)
  return {
    longAccountRatio,
    shortAccountRatio,
    longShortRatio: longAccountRatio / shortAccountRatio,
  }
}
