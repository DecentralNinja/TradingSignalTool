import {
  getMarkPriceAndFunding,
  getOpenInterest,
  getLongShortRatio,
  getTakerBuySellVolume,
  getTopTraderPositionRatio,
  getBasis,
} from './binance.js'
import { getTicker as getBybitTicker, getLongShortRatio as getBybitLongShortRatio } from './bybit.js'
import { getFearGreedIndex } from './fearGreed.js'
import {
  saveSnapshot,
  getRecentSnapshots,
  saveSignal,
  getRecentVolatilities,
  getSignalsPendingOutcome,
  getSnapshotPrice,
  saveSignalOutcome,
} from './supabase.js'
import { evaluateSignal, classifyVolatilityRegime, WINDOW_HOURS } from './signal.js'
import { evaluateOutcome } from './accuracy.js'

const SYMBOL = 'BTCUSDT'

async function fetchSnapshot(symbol) {
  const [price, oi, longShort, takerVol, topTrader, basis, bybitTicker, bybitLongShort, fearGreed] =
    await Promise.all([
      getMarkPriceAndFunding(symbol),
      getOpenInterest(symbol),
      getLongShortRatio(symbol),
      getTakerBuySellVolume(symbol),
      getTopTraderPositionRatio(symbol),
      getBasis(symbol),
      getBybitTicker(symbol),
      getBybitLongShortRatio(symbol),
      getFearGreedIndex(),
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
    bybit_mark_price: bybitTicker.markPrice,
    bybit_funding_rate: bybitTicker.fundingRate,
    bybit_next_funding_time: new Date(bybitTicker.nextFundingTime).toISOString(),
    bybit_open_interest: bybitTicker.openInterest,
    bybit_long_account_ratio: bybitLongShort.longAccountRatio,
    bybit_short_account_ratio: bybitLongShort.shortAccountRatio,
    bybit_long_short_ratio: bybitLongShort.longShortRatio,
    fear_greed_value: fearGreed.value,
    fear_greed_classification: fearGreed.classification,
  }
}

// Signals from WINDOW_HOURS ago have had their window play out, so we can now
// check whether they were actually right.
async function scorePendingOutcomes(client, snapshot) {
  const cutoff = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString()
  const pending = await getSignalsPendingOutcome(client, SYMBOL, cutoff)
  const scored = []

  for (const pendingSignal of pending) {
    const originalPrice = await getSnapshotPrice(client, SYMBOL, pendingSignal.evaluated_at)
    if (originalPrice == null) continue

    const { correct, priceChangePct } = evaluateOutcome(
      pendingSignal.signal,
      originalPrice,
      snapshot.mark_price
    )

    await saveSignalOutcome(client, pendingSignal.id, {
      outcome_price: snapshot.mark_price,
      outcome_evaluated_at: snapshot.fetched_at,
      outcome_correct: correct,
    })

    scored.push({ id: pendingSignal.id, signal: pendingSignal.signal, correct, priceChangePct })
  }

  return scored
}

// Runs one full cycle: fetch, save, evaluate the signal, score any signals
// whose window has now played out. Shared by the CLI entry point and the
// Lambda handler so the two never drift apart.
export async function runFetchCycle(client) {
  const snapshot = await fetchSnapshot(SYMBOL)
  await saveSnapshot(client, snapshot)

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
  const scoredOutcomes = await scorePendingOutcomes(client, snapshot)

  return { snapshot, signal: signalRow, scoredOutcomes }
}
