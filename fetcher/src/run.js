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
import { getLeveragedFundsPositioning } from './cftc.js'
import {
  saveSnapshot,
  getRecentSnapshots,
  saveSignal,
  getRecentVolatilities,
  getSignalsPendingOutcome,
  getSnapshotPrice,
  saveSignalOutcome,
  saveLiquidationClusters,
} from './supabase.js'
import {
  evaluateSignal,
  evaluateShortTermSignal,
  classifyVolatilityRegime,
  computeRealizedVolatility,
  WINDOW_HOURS,
  SHORT_WINDOW_HOURS,
} from './signal.js'
import { evaluateOutcome } from './accuracy.js'
import { computeLiquidationHeatmap, findConfirmedClusters } from './liquidationHeatmap.js'

// Multiple lookback windows for multi-timeframe cluster confirmation. 7d is
// currently close to the ceiling of what live history supports; widen this
// as more history accumulates (see backtest.js for a 30-day version using
// Binance's own historical data instead of our live collection).
const HEATMAP_WINDOW_HOURS = [24, 72, 168]

const SYMBOL = 'BTCUSDT'

async function fetchSnapshot(symbol) {
  const [price, oi, longShort, takerVol, topTrader, basis, bybitTicker, bybitLongShort, fearGreed, cftc] =
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
      getLeveragedFundsPositioning(),
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
    cftc_report_date: new Date(cftc.reportDate).toISOString(),
    cftc_lev_funds_long: cftc.leveragedFundsLong,
    cftc_lev_funds_short: cftc.leveragedFundsShort,
    cftc_lev_funds_long_short_ratio: cftc.leveragedFundsLongShortRatio,
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
// same timeframe has aged out of its window. Volatility/regime is computed
// here for both timeframes (previously only the 4h one tracked it, so 1h
// signals always had a null volatility_regime) and stored for display --
// informational only, not currently used to gate any rule.
//
// concurrentSignal (only passed for the 1h call, using the already-computed
// 4h result from earlier in the same cycle) downgrades a 'proven' 1h call to
// 'experimental' when the 4h signal already agrees. Backtested confluence
// test: 1h proven-combo calls where 4h was neutral hit 77.4% win / +0.067%
// net (n=31); the same calls when 4h already agreed were only 55.6% win /
// ~breakeven (n=27) -- a "confirmed" 1h move already telegraphed by the
// slower timeframe performs worse than a fresh one, not better.
async function runTimeframe(client, snapshot, { timeframe, windowHours, evaluateFn, concurrentSignal }) {
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()
  const windowSnapshots = await getRecentSnapshots(client, SYMBOL, windowStart)

  const volatility = computeRealizedVolatility(windowSnapshots)
  let volatilityRegime = null
  if (volatility != null) {
    const recentVolatilities = await getRecentVolatilities(client, SYMBOL, timeframe, 50)
    volatilityRegime = classifyVolatilityRegime(volatility, recentVolatilities)
  }

  const { signal, score, reason, combo, confidence: baseConfidence } = evaluateFn(windowSnapshots)
  const confidence =
    baseConfidence === 'proven' && concurrentSignal && concurrentSignal === signal ? 'experimental' : baseConfidence

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

// Computes multi-timeframe-confirmed liquidation clusters and saves them.
// Informational only right now -- not wired into evaluateSignal/
// evaluateShortTermSignal's rules, since this hasn't been backtested yet
// (see fetcher/backtest.js and signal.js's PROVEN_COMBOS discipline).
async function computeAndSaveLiquidationClusters(client, snapshot) {
  const heatmaps = []
  for (const hours of HEATMAP_WINDOW_HOURS) {
    const windowStart = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
    const windowSnapshots = await getRecentSnapshots(client, SYMBOL, windowStart)
    heatmaps.push(computeLiquidationHeatmap(windowSnapshots, snapshot.mark_price))
  }

  const clusters = findConfirmedClusters(heatmaps, snapshot.mark_price)

  await saveLiquidationClusters(
    client,
    clusters.map((c) => ({
      symbol: SYMBOL,
      computed_at: snapshot.fetched_at,
      reference_price: snapshot.mark_price,
      cluster_price: c.price,
      dominant_side: c.dominantSide,
      windows_confirmed_in: c.windowsConfirmedIn,
    }))
  )

  return clusters
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
    concurrentSignal: structural.signal.signal,
  })

  const liquidationClusters = await computeAndSaveLiquidationClusters(client, snapshot)

  return {
    snapshot,
    signal: structural.signal,
    scoredOutcomes: structural.scoredOutcomes,
    shortTermSignal: momentum.signal,
    shortTermScoredOutcomes: momentum.scoredOutcomes,
    liquidationClusters,
  }
}
