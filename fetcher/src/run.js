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
  getPreviousSignal,
  getRecentVolatilities,
  getSignalsPendingOutcome,
  getSnapshotPrice,
  saveSignalOutcome,
  saveLiquidationClusters,
} from './supabase.js'
import { sendWhatsApp } from './notify.js'
import {
  evaluateSignal,
  evaluateShortTermSignal,
  classifyVolatilityRegime,
  computeRealizedVolatility,
  suggestTradeLevels,
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

// Reference leverage used only for the ROI% shown in TP/SL alerts -- doesn't
// affect the price levels themselves, just how the percentage move is framed.
const REFERENCE_LEVERAGE = 10

const SYMBOL = 'BTCUSDT'

// Wraps a data-source fetch so its failure doesn't kill the whole cycle via
// Promise.all rejection -- logs and returns `fallback` instead of throwing.
// Only used for basis and CFTC: real production incident history (5 days of
// CloudWatch logs, 2026-08-19) showed 129 entire cycles lost this way -- 126
// from Binance IP bans specifically on the basis endpoint, 3 from a brief
// CFTC 503 outage -- roughly 27% of all cycles in that window. Both rules
// already treat these fields as optional (scoreBasis scores 0 on null; CFTC
// isn't used in scoring at all, just displayed), so this is safe. The other
// 8 sources below stay fatal on purpose -- there's no meaningful signal to
// evaluate without price/OI/etc, so failing loudly there is correct.
async function safeFetch(promise, label, fallback) {
  try {
    return await promise
  } catch (err) {
    console.error(`${label} failed, continuing without it: ${err.message}`)
    return fallback
  }
}

async function fetchSnapshot(symbol) {
  const [price, oi, longShort, takerVol, topTrader, basis, bybitTicker, bybitLongShort, fearGreed, cftc] =
    await Promise.all([
      getMarkPriceAndFunding(symbol),
      getOpenInterest(symbol),
      getLongShortRatio(symbol),
      getTakerBuySellVolume(symbol),
      getTopTraderPositionRatio(symbol),
      safeFetch(getBasis(symbol), 'getBasis', { basis: null, basisRate: null }),
      getBybitTicker(symbol),
      getBybitLongShortRatio(symbol),
      getFearGreedIndex(),
      safeFetch(getLeveragedFundsPositioning(), 'getLeveragedFundsPositioning', {
        reportDate: null,
        leveragedFundsLong: null,
        leveragedFundsShort: null,
        leveragedFundsLongShortRatio: null,
      }),
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
    cftc_report_date: cftc.reportDate ? new Date(cftc.reportDate).toISOString() : null,
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

  // Concrete TP/SL price levels, sized off the historical average win/loss
  // for this exact combo -- null for experimental signals or combos without
  // a TRADE_LEVELS entry (see signal.js).
  const tradeLevels =
    signal !== 'neutral' ? suggestTradeLevels(timeframe, signal, combo, snapshot.mark_price) : null

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
    take_profit_price: tradeLevels?.takeProfitPrice ?? null,
    stop_loss_price: tradeLevels?.stopLossPrice ?? null,
    exit_by_hours: tradeLevels?.exitByHours ?? null,
    take_profit_pct: tradeLevels?.avgWinPct ?? null,
    stop_loss_pct: tradeLevels?.avgLossPct ?? null,
  }

  // WhatsApp alert only for a NEW proven bullish/bearish call -- not neutral
  // (the whole point), not experimental (unproven combos aren't worth an
  // interruption), and not a repeat of the same direction already alerted on
  // last cycle (this rule re-fires every 15min while a signal holds).
  const previousSignal = await getPreviousSignal(client, SYMBOL, timeframe)
  if (signal !== 'neutral' && confidence === 'proven' && signal !== previousSignal) {
    const dot = signal === 'bullish' ? '🟢' : '🔴'
    let message = `${dot} BTC ${timeframe} ${signal.toUpperCase()} signal (proven)\nPrice: $${snapshot.mark_price.toLocaleString('en-US')}\n${combo}`

    if (tradeLevels) {
      const tpRoi = tradeLevels.avgWinPct * REFERENCE_LEVERAGE
      const slRoi = tradeLevels.avgLossPct * REFERENCE_LEVERAGE
      const fmtPct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
      const fmtRoi = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}% ROI @${REFERENCE_LEVERAGE}x`
      message += `\n\nTP: $${tradeLevels.takeProfitPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${fmtPct(tradeLevels.avgWinPct)}, ${fmtRoi(tpRoi)})`
      message += `\nSL: $${tradeLevels.stopLossPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${fmtPct(tradeLevels.avgLossPct)}, ${fmtRoi(slRoi)})`
      message += `\nExit by: ${tradeLevels.exitByHours}h if neither hit`
    }

    await sendWhatsApp(message)
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
