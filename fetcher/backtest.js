// Reconstructs ~30 days of historical snapshots from Binance's own historical
// endpoints (the retention limit for most of these), replays the live signal
// logic against them, and reports real accuracy instead of waiting weeks for
// our own live collection to accumulate enough history.
//
// Scope note: Bybit cross-exchange confirmation is excluded here (always
// scores 0) since replaying it accurately would need Bybit's own historical
// funding data too -- a reasonable simplification, not a blocker.
import { config } from 'dotenv'
config({ quiet: true })
import { evaluateSignal, evaluateShortTermSignal, WINDOW_HOURS, SHORT_WINDOW_HOURS } from './src/signal.js'
import { evaluateOutcome } from './src/accuracy.js'

const SYMBOL = 'BTCUSDT'
const BASE = 'https://fapi.binance.com'
const DAYS_BACK = 30
const INTERVAL_MS = 15 * 60 * 1000
const PACE_MS = 200

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`${url} failed: ${res.status} ${await res.text()}`)
  }
  return res.json()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 500-per-call limit on these endpoints; step through with startTime/endTime.
async function fetchPaginated(pathBuilder, startTime, endTime) {
  const chunkMs = 500 * INTERVAL_MS
  const results = []
  let cursor = startTime

  while (cursor < endTime) {
    const chunkEnd = Math.min(cursor + chunkMs, endTime)
    const data = await fetchJson(pathBuilder(cursor, chunkEnd))
    results.push(...data)
    cursor = chunkEnd
    await sleep(PACE_MS)
  }

  return results
}

async function fetchKlines(startTime, endTime) {
  const klines = []
  let cursor = startTime

  while (cursor < endTime) {
    const data = await fetchJson(
      `${BASE}/fapi/v1/klines?symbol=${SYMBOL}&interval=15m&startTime=${cursor}&limit=1500`
    )
    if (data.length === 0) break
    klines.push(...data)
    cursor = data[data.length - 1][0] + INTERVAL_MS
    await sleep(PACE_MS)
  }

  return klines
}

async function fetchAllHistoricalData() {
  const endTime = Date.now()
  const startTime = endTime - DAYS_BACK * 24 * 60 * 60 * 1000

  console.log('Fetching klines (price)...')
  const klines = await fetchKlines(startTime, endTime)

  console.log('Fetching funding rate history...')
  const fundingRates = await fetchJson(
    `${BASE}/fapi/v1/fundingRate?symbol=${SYMBOL}&startTime=${startTime}&endTime=${endTime}&limit=1000`
  )
  await sleep(PACE_MS)

  console.log('Fetching open interest history...')
  const openInterest = await fetchPaginated(
    (s, e) => `${BASE}/futures/data/openInterestHist?symbol=${SYMBOL}&period=15m&startTime=${s}&endTime=${e}&limit=500`,
    startTime,
    endTime
  )

  console.log('Fetching long/short ratio history...')
  const longShort = await fetchPaginated(
    (s, e) =>
      `${BASE}/futures/data/globalLongShortAccountRatio?symbol=${SYMBOL}&period=15m&startTime=${s}&endTime=${e}&limit=500`,
    startTime,
    endTime
  )

  console.log('Fetching top trader ratio history...')
  const topTrader = await fetchPaginated(
    (s, e) =>
      `${BASE}/futures/data/topLongShortPositionRatio?symbol=${SYMBOL}&period=15m&startTime=${s}&endTime=${e}&limit=500`,
    startTime,
    endTime
  )

  console.log('Fetching taker flow history...')
  const takerFlow = await fetchPaginated(
    (s, e) => `${BASE}/futures/data/takerlongshortRatio?symbol=${SYMBOL}&period=15m&startTime=${s}&endTime=${e}&limit=500`,
    startTime,
    endTime
  )

  console.log('Fetching basis history...')
  const basis = await fetchPaginated(
    (s, e) =>
      `${BASE}/futures/data/basis?pair=${SYMBOL}&contractType=PERPETUAL&period=15m&startTime=${s}&endTime=${e}&limit=500`,
    startTime,
    endTime
  )

  console.log('Fetching Fear & Greed history...')
  const fearGreedRaw = await fetchJson(`https://api.alternative.me/fng/?limit=${DAYS_BACK + 2}`)

  return {
    klines,
    fundingRates,
    openInterest,
    longShort,
    topTrader,
    takerFlow,
    basis,
    fearGreed: fearGreedRaw.data,
  }
}

// Builds a lookup: given a sorted series of {t, ...fields}, find the most
// recent entry at or before a target timestamp (forward-fill), matching how
// the live fetcher always reports "the current value" regardless of when it
// last actually changed (e.g. funding rate, which only updates every 8h).
function makeLookup(series, getTime) {
  const sorted = [...series].sort((a, b) => getTime(a) - getTime(b))
  return (targetMs) => {
    let result = null
    for (const entry of sorted) {
      if (getTime(entry) > targetMs) break
      result = entry
    }
    return result
  }
}

function reconstructSnapshots(raw) {
  const fundingLookup = makeLookup(raw.fundingRates, (r) => r.fundingTime)
  const oiLookup = makeLookup(raw.openInterest, (r) => r.timestamp)
  const longShortLookup = makeLookup(raw.longShort, (r) => r.timestamp)
  const topTraderLookup = makeLookup(raw.topTrader, (r) => r.timestamp)
  const takerLookup = makeLookup(raw.takerFlow, (r) => r.timestamp)
  const basisLookup = makeLookup(raw.basis, (r) => r.timestamp)
  const fearGreedLookup = makeLookup(raw.fearGreed, (r) => Number(r.timestamp) * 1000)

  const snapshots = []

  for (const k of raw.klines) {
    const t = k[0]
    const funding = fundingLookup(t)
    const oi = oiLookup(t)
    const longShort = longShortLookup(t)
    const topTrader = topTraderLookup(t)
    const taker = takerLookup(t)
    const basisEntry = basisLookup(t)
    const fearGreed = fearGreedLookup(t)

    if (!oi || !longShort || !taker) continue

    snapshots.push({
      fetched_at: new Date(t).toISOString(),
      mark_price: Number(k[4]),
      funding_rate: funding ? Number(funding.fundingRate) : 0,
      open_interest: Number(oi.sumOpenInterest),
      long_short_ratio: Number(longShort.longShortRatio),
      taker_buy_sell_ratio: Number(taker.buySellRatio),
      top_trader_long_short_ratio: topTrader ? Number(topTrader.longShortRatio) : null,
      basis_rate: basisEntry ? Number(basisEntry.basisRate) : null,
      bybit_funding_rate: null,
      fear_greed_value: fearGreed ? Number(fearGreed.value) : null,
    })
  }

  return snapshots
}

function windowSlice(snapshots, endIndex, windowHours) {
  const windowMs = windowHours * 60 * 60 * 1000
  const endTime = new Date(snapshots[endIndex].fetched_at).getTime()
  const startTime = endTime - windowMs
  const slice = []
  for (let i = endIndex; i >= 0; i--) {
    const t = new Date(snapshots[i].fetched_at).getTime()
    if (t < startTime) break
    slice.unshift(snapshots[i])
  }
  return slice
}

function reportRuleBreakdown(results, signalType) {
  const filtered = results.filter((r) => r.signal === signalType)
  if (filtered.length === 0) return

  const perRule = {}
  for (const r of filtered) {
    for (const rule of r.rules) {
      if (rule.score === 0) continue
      perRule[rule.rule] = perRule[rule.rule] || { presentCorrect: 0, presentIncorrect: 0 }
      if (r.correct) perRule[rule.rule].presentCorrect++
      else perRule[rule.rule].presentIncorrect++
    }
  }

  console.log(`  -- rule presence within ${signalType} calls (${filtered.length} total) --`)
  for (const [rule, { presentCorrect, presentIncorrect }] of Object.entries(perRule)) {
    const total = presentCorrect + presentIncorrect
    const pct = ((presentCorrect / total) * 100).toFixed(1)
    console.log(`     ${rule}: present in ${total}/${filtered.length} (${pct}% of those were correct)`)
  }
}

function backtestTimeframe(snapshots, windowHours, evaluateFn, label) {
  const results = []

  for (let i = 0; i < snapshots.length; i++) {
    const window = windowSlice(snapshots, i, windowHours)
    if (window.length < 2) continue

    const { signal, rules } = evaluateFn(window)
    const evaluatedAtMs = new Date(snapshots[i].fetched_at).getTime()
    const outcomeIndex = snapshots.findIndex(
      (s) => new Date(s.fetched_at).getTime() >= evaluatedAtMs + windowHours * 60 * 60 * 1000
    )

    if (outcomeIndex === -1) continue

    const { correct, priceChangePct } = evaluateOutcome(
      signal,
      snapshots[i].mark_price,
      snapshots[outcomeIndex].mark_price
    )
    // Trade return if you'd acted on the call: long on bullish (profits when
    // price rises), short on bearish (profits when price falls) -- so bearish
    // flips the sign of the raw price move.
    const tradeReturnPct = signal === 'bearish' ? -priceChangePct : priceChangePct
    results.push({ signal, correct, rules, tradeReturnPct })
  }

  // Counts distinct episodes rather than raw 15-min ticks: four consecutive
  // bullish readings in a row is one ongoing signal, not four separate ones.
  const episodes = { bullish: 0, bearish: 0 }
  let previousSignal = null
  for (const r of results) {
    if ((r.signal === 'bullish' || r.signal === 'bearish') && r.signal !== previousSignal) {
      episodes[r.signal]++
    }
    previousSignal = r.signal
  }
  const days = results.length / 96

  const byType = { bullish: { correct: 0, total: 0 }, bearish: { correct: 0, total: 0 }, neutral: { correct: 0, total: 0 } }
  for (const r of results) {
    byType[r.signal].total++
    if (r.correct) byType[r.signal].correct++
  }

  console.log(`\n=== ${label} backtest (${results.length} evaluated signals over ~${days.toFixed(1)} days) ===`)
  for (const [type, { correct, total }] of Object.entries(byType)) {
    const pct = total > 0 ? ((correct / total) * 100).toFixed(1) : 'n/a'
    console.log(`  ${type}: ${correct}/${total} correct (${pct}%)`)
  }
  console.log(
    `  episodes (distinct signal events, not raw ticks): ${episodes.bullish} bullish total (${(episodes.bullish / days).toFixed(2)}/day), ${episodes.bearish} bearish total (${(episodes.bearish / days).toFixed(2)}/day)`
  )

  reportRuleBreakdown(results, 'bearish')
  reportRuleBreakdown(results, 'bullish')
  reportExpectancy(results, 'bullish')
  reportExpectancy(results, 'bearish')
}

// Expectancy: the average return per trade if every call were acted on with
// equal size, no leverage, before fees/slippage. This is what "58% accurate"
// actually needs to mean anything financially -- a high win rate with tiny
// wins and large losses can still lose money overall, and vice versa.
function reportExpectancy(results, signalType) {
  const trades = results.filter((r) => r.signal === signalType)
  if (trades.length === 0) return

  const wins = trades.filter((t) => t.tradeReturnPct > 0)
  const losses = trades.filter((t) => t.tradeReturnPct <= 0)
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.tradeReturnPct, 0) / wins.length : 0
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.tradeReturnPct, 0) / losses.length : 0
  const avgReturn = trades.reduce((s, t) => s + t.tradeReturnPct, 0) / trades.length
  const winRate = (wins.length / trades.length) * 100

  console.log(`  -- ${signalType} expectancy (before fees/slippage, no leverage, equal size) --`)
  console.log(`     win rate: ${winRate.toFixed(1)}% (${wins.length}/${trades.length})`)
  console.log(`     avg win: +${avgWin.toFixed(3)}%   avg loss: ${avgLoss.toFixed(3)}%`)
  console.log(`     average return per trade: ${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(3)}%`)
}

async function main() {
  const raw = await fetchAllHistoricalData()
  console.log(
    `\nFetched: ${raw.klines.length} klines, ${raw.fundingRates.length} funding, ${raw.openInterest.length} OI, ${raw.longShort.length} long/short, ${raw.topTrader.length} top trader, ${raw.takerFlow.length} taker, ${raw.basis.length} basis, ${raw.fearGreed.length} fear/greed`
  )

  const snapshots = reconstructSnapshots(raw)
  console.log(`Reconstructed ${snapshots.length} aligned snapshots`)

  backtestTimeframe(snapshots, WINDOW_HOURS, evaluateSignal, '4-Hour')
  backtestTimeframe(snapshots, SHORT_WINDOW_HOURS, evaluateShortTermSignal, '1-Hour')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
