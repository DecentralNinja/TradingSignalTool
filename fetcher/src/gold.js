import { withRetry } from './retry.js'

// Yahoo Finance's chart endpoint is unofficial/undocumented (no key, but no
// guarantee it stays this way either) -- backtested as a real, independent
// edge for the 4h signal (see backtest.js), worth using despite that risk.
// GC=F is COMEX gold futures.
const URL = 'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=15m&range=1d'

export async function getGoldPrice() {
  return withRetry(async () => {
    const res = await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) {
      throw new Error(`Gold price fetch failed: ${res.status} ${await res.text()}`)
    }
    const data = await res.json()
    const price = data.chart?.result?.[0]?.meta?.regularMarketPrice
    if (price == null) {
      throw new Error('Gold price fetch returned no regularMarketPrice')
    }
    return { price: Number(price) }
  })
}
