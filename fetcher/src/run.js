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
import {
  evaluateSignal,
  evaluateShortTermSignal,
  classifyVolatilityRegime,
  WINDOW_HOURS,
  SHORT_WINDOW_HOURS,
} from './signal.js'
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

// Signals from windowHours ago (for this timeframe) have had their window
// play out, so we can now check whether they were actually right.
async function scorePendingOutcomes(client, timeframe, windowHours, snapshot) {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()
  const pending = await getSignalsPendingOutcome(client, SYMBOL, timeframe, cutoff)
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

// Evaluates one timeframe's signal, saves it, and scores whatever from that
// same timeframe has aged out of its window. volatility tracking only applies
// to the 4h structural signal (evaluateFn's return value simply won't include
// it for the 1h one).
async function runTimeframe(client, snapshot, { timeframe, windowHours, evaluateFn }) {
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()
  const windowSnapshots = await getRecentSnapshots(client, SYMBOL, windowStart)
  const { signal, score, reason, volatility, combo, confidence } = evaluateFn(windowSnapshots)

  let volatilityRegime = null
  if (volatility !== undefined) {
    const recentVolatilities = await getRecentVolatilities(client, SYMBOL, timeframe, 50)
    volatilityRegime = classifyVolatilityRegime(volatility, recentVolatilities)
  }

  const signalRow = {
    symbol: SYMBOL,
    timeframe,
    evaluated_at: snapshot.fetched_at,
    window_start: windowStart,
    window_end: snapshot.fetched_at,
    signal,
    reason: `score ${score} (${windowSnapshots.length} snapshot${windowSnapshots.length === 1 ? '' : 's'} in window): ${reason}`,
    combo,
    confidence,
    volatility: volatility ?? null,
    volatility_regime: volatilityRegime,
  }

  await saveSignal(client, signalRow)
  const scoredOutcomes = await scorePendingOutcomes(client, timeframe, windowHours, snapshot)

  return { signal: signalRow, scoredOutcomes }
}

// Runs one full cycle: fetch, save, evaluate both the 4h and 1h signals, score
// any signals whose window has now played out. Shared by the CLI entry point
// and the Lambda handler so the two never drift apart.
export async function runFetchCycle(client) {
  const snapshot = await fetchSnapshot(SYMBOL)
  await saveSnapshot(client, snapshot)

  const structural = await runTimeframe(client, snapshot, {
    timeframe: '4h',
    windowHours: WINDOW_HOURS,
    evaluateFn: evaluateSignal,
  })

  const momentum = await runTimeframe(client, snapshot, {
    timeframe: '1h',
    windowHours: SHORT_WINDOW_HOURS,
    evaluateFn: evaluateShortTermSignal,
  })

  return {
    snapshot,
    signal: structural.signal,
    scoredOutcomes: structural.scoredOutcomes,
    shortTermSignal: momentum.signal,
    shortTermScoredOutcomes: momentum.scoredOutcomes,
  }
}
