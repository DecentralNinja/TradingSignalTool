import { config } from 'dotenv'
config({ quiet: true })
import {
  getMarkPriceAndFunding,
  getOpenInterest,
  getLongShortRatio,
  getTakerBuySellVolume,
  getTopTraderPositionRatio,
  getBasis,
} from './src/binance.js'
import {
  getSupabaseClient,
  saveSnapshot,
  getRecentSnapshots,
  saveSignal,
  getRecentVolatilities,
} from './src/supabase.js'
import { evaluateSignal, classifyVolatilityRegime, WINDOW_HOURS } from './src/signal.js'

const SYMBOL = 'BTCUSDT'

async function fetchSnapshot(symbol) {
  const [price, oi, longShort, takerVol, topTrader, basis] = await Promise.all([
    getMarkPriceAndFunding(symbol),
    getOpenInterest(symbol),
    getLongShortRatio(symbol),
    getTakerBuySellVolume(symbol),
    getTopTraderPositionRatio(symbol),
    getBasis(symbol),
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
    top_trader_long_account_ratio: topTrader.longAccountRatio,
    top_trader_short_account_ratio: topTrader.shortAccountRatio,
    top_trader_long_short_ratio: topTrader.longShortRatio,
    basis: basis.basis,
    basis_rate: basis.basisRate,
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

  const windowStart = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString()
  const windowSnapshots = await getRecentSnapshots(client, SYMBOL, windowStart)
  const { signal, score, reason, volatility } = evaluateSignal(windowSnapshots)

  const recentVolatilities = await getRecentVolatilities(client, SYMBOL, 50)
  const volatilityRegime = classifyVolatilityRegime(volatility, recentVolatilities)

  const signalRow = {
    symbol: SYMBOL,
    evaluated_at: snapshot.fetched_at,
    window_start: windowStart,
    window_end: snapshot.fetched_at,
    signal,
    reason: `score ${score} (${windowSnapshots.length} snapshot${windowSnapshots.length === 1 ? '' : 's'} in window): ${reason}`,
    volatility,
    volatility_regime: volatilityRegime,
  }

  await saveSignal(client, signalRow)
  console.log('Signal:', signalRow)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
