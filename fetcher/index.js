import { config } from 'dotenv'
config({ quiet: true })
import {
  getMarkPriceAndFunding,
  getOpenInterest,
  getLongShortRatio,
  getTakerBuySellVolume,
} from './src/binance.js'
import { getSupabaseClient, saveSnapshot } from './src/supabase.js'

const SYMBOL = 'BTCUSDT'

async function fetchSnapshot(symbol) {
  const [price, oi, longShort, takerVol] = await Promise.all([
    getMarkPriceAndFunding(symbol),
    getOpenInterest(symbol),
    getLongShortRatio(symbol),
    getTakerBuySellVolume(symbol),
  ])

  return {
    symbol,
    fetched_at: new Date().toISOString(),
    mark_price: price.markPrice,
    funding_rate: price.fundingRate,
    next_funding_time: new Date(price.nextFundingTime).toISOString(),
    open_interest: oi.openInterest,
    long_account_ratio: longShort.longAccountRatio,
    short_account_ratio: longShort.shortAccountRatio,
    long_short_ratio: longShort.longShortRatio,
    taker_buy_vol: takerVol.buyVol,
    taker_sell_vol: takerVol.sellVol,
    taker_buy_sell_ratio: takerVol.buySellRatio,
  }
}

async function main() {
  const snapshot = await fetchSnapshot(SYMBOL)
  console.log(snapshot)

  const client = getSupabaseClient()
  if (!client) {
    console.warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping DB write.')
    return
  }

  await saveSnapshot(client, snapshot)
  console.log('Saved to Supabase.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
