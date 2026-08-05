const FUTURES_BASE = 'https://fapi.binance.com'

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`${url} failed: ${res.status} ${await res.text()}`)
  }
  return res.json()
}

// premiumIndex gives mark price and the current funding rate in a single call
export async function getMarkPriceAndFunding(symbol) {
  const data = await fetchJson(`${FUTURES_BASE}/fapi/v1/premiumIndex?symbol=${symbol}`)
  return {
    markPrice: Number(data.markPrice),
    fundingRate: Number(data.lastFundingRate),
    nextFundingTime: data.nextFundingTime,
  }
}

export async function getOpenInterest(symbol) {
  const data = await fetchJson(`${FUTURES_BASE}/fapi/v1/openInterest?symbol=${symbol}`)
  return {
    openInterest: Number(data.openInterest),
    time: data.time,
  }
}

export async function getLongShortRatio(symbol) {
  const [data] = await fetchJson(
    `${FUTURES_BASE}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=15m&limit=1`
  )
  return {
    longAccountRatio: Number(data.longAccount),
    shortAccountRatio: Number(data.shortAccount),
    longShortRatio: Number(data.longShortRatio),
    timestamp: Number(data.timestamp),
  }
}

export async function getTakerBuySellVolume(symbol) {
  const [data] = await fetchJson(
    `${FUTURES_BASE}/futures/data/takerlongshortRatio?symbol=${symbol}&period=15m&limit=1`
  )
  return {
    buyVol: Number(data.buyVol),
    sellVol: Number(data.sellVol),
    buySellRatio: Number(data.buySellRatio),
  }
}

// Position-size-weighted, restricted to Binance's top traders (not all accounts).
export async function getTopTraderPositionRatio(symbol) {
  const [data] = await fetchJson(
    `${FUTURES_BASE}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=15m&limit=1`
  )
  return {
    longAccountRatio: Number(data.longAccount),
    shortAccountRatio: Number(data.shortAccount),
    longShortRatio: Number(data.longShortRatio),
  }
}

// Spread between the perpetual futures price and the index (spot) price.
export async function getBasis(symbol) {
  const [data] = await fetchJson(
    `${FUTURES_BASE}/futures/data/basis?pair=${symbol}&contractType=PERPETUAL&period=15m&limit=1`
  )
  return {
    basis: Number(data.basis),
    basisRate: Number(data.basisRate),
  }
}
