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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { evaluateSignal, evaluateShortTermSignal, PROVEN_COMBOS, WINDOW_HOURS, SHORT_WINDOW_HOURS } from './src/signal.js'
import { evaluateOutcome } from './src/accuracy.js'
import { computeLiquidationHeatmap, findConfirmedClusters, PROXIMITY_PCT } from './src/liquidationHeatmap.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(__dirname, '.backtest-cache')
// Reuse recent fetches across retries so a ban that hits one endpoint (e.g.
// basis, fetched last) doesn't force re-burning IP weight on the 6 endpoints
// that already succeeded earlier in the run -- that repeat burn is what kept
// re-triggering fresh bans on every retry.
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000

async function cached(name, fetchFn) {
  const path = join(CACHE_DIR, `${name}.json`)
  if (existsSync(path)) {
    const entry = JSON.parse(readFileSync(path, 'utf8'))
    if (Date.now() - entry.fetchedAt < CACHE_MAX_AGE_MS) {
      console.log(`  (using cached ${name}, ${((Date.now() - entry.fetchedAt) / 60000).toFixed(0)}min old)`)
      return entry.data
    }
  }
  const data = await fetchFn()
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), data }))
  return data
}

const SYMBOL = 'BTCUSDT'
const BASE = 'https://fapi.binance.com'
const DAYS_BACK = 30
const INTERVAL_MS = 15 * 60 * 1000
// Bumped from 200ms -> 1000ms after a real ban, then banned again at 1000ms
// (same IP, same basis endpoint) -- this IP has likely accumulated elevated
// request weight from a full day of testing (backtests, liquidation
// WebSocket tests, live fetcher runs), not just this script's own pacing.
// Bumped further as a precaution.
const PACE_MS = 3000

// Binance USDT-M futures taker fee, VIP 0 tier -- charged on both entry and
// exit, so round-trip is double. Excludes funding payments (varies with hold
// time and side, harder to model precisely) and slippage, so real cost is
// likely somewhat higher than this -- treat as a floor, not a ceiling.
const TAKER_FEE_PCT = 0.05
const ROUND_TRIP_FEE_PCT = TAKER_FEE_PCT * 2
const MIN_COMBO_SAMPLE = 5

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
  const klines = await cached('klines', () => fetchKlines(startTime, endTime))

  console.log('Fetching funding rate history...')
  const fundingRates = await cached('funding', async () => {
    const data = await fetchJson(
      `${BASE}/fapi/v1/fundingRate?symbol=${SYMBOL}&startTime=${startTime}&endTime=${endTime}&limit=1000`
    )
    await sleep(PACE_MS)
    return data
  })

  console.log('Fetching open interest history...')
  const openInterest = await cached('oi', async () => {
    const data = await fetchPaginated(
      (s, e) => `${BASE}/futures/data/openInterestHist?symbol=${SYMBOL}&period=15m&startTime=${s}&endTime=${e}&limit=500`,
      startTime,
      endTime
    )
    await sleep(PACE_MS)
    return data
  })

  console.log('Fetching long/short ratio history...')
  const longShort = await cached('longshort', async () => {
    const data = await fetchPaginated(
      (s, e) =>
        `${BASE}/futures/data/globalLongShortAccountRatio?symbol=${SYMBOL}&period=15m&startTime=${s}&endTime=${e}&limit=500`,
      startTime,
      endTime
    )
    await sleep(PACE_MS)
    return data
  })

  console.log('Fetching top trader ratio history...')
  const topTrader = await cached('toptrader', async () => {
    const data = await fetchPaginated(
      (s, e) =>
        `${BASE}/futures/data/topLongShortPositionRatio?symbol=${SYMBOL}&period=15m&startTime=${s}&endTime=${e}&limit=500`,
      startTime,
      endTime
    )
    await sleep(PACE_MS)
    return data
  })

  console.log('Fetching taker flow history...')
  const takerFlow = await cached('taker', async () => {
    const data = await fetchPaginated(
      (s, e) => `${BASE}/futures/data/takerlongshortRatio?symbol=${SYMBOL}&period=15m&startTime=${s}&endTime=${e}&limit=500`,
      startTime,
      endTime
    )
    await sleep(PACE_MS)
    return data
  })

  console.log('Fetching basis history...')
  // Non-fatal: the liquidation cluster backtest doesn't use basis at all (only
  // OI + price), and it's been the one endpoint repeatedly triggering IP bans.
  // Falling back to [] lets the rest of the run (including the cluster
  // backtest) complete instead of dying on a rule that isn't even needed here
  // -- the 4h/1h basis rule just scores neutral for this run if it's missing.
  let basis = []
  try {
    basis = await cached('basis', () =>
      fetchPaginated(
        (s, e) =>
          `${BASE}/futures/data/basis?pair=${SYMBOL}&contractType=PERPETUAL&period=15m&startTime=${s}&endTime=${e}&limit=500`,
        startTime,
        endTime
      )
    )
  } catch (err) {
    console.log(`  basis fetch failed, continuing without it: ${err.message}`)
  }

  console.log('Fetching Fear & Greed history...')
  const fearGreedRaw = await cached('feargreed', () => fetchJson(`https://api.alternative.me/fng/?limit=${DAYS_BACK + 2}`))

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

// Windows in hours for multi-timeframe cluster confirmation, matching
// fetcher/src/run.js's live HEATMAP_WINDOW_HOURS.
const CLUSTER_WINDOWS_HOURS = [24, 72, 168]

// Nearest confirmed cluster to current price, whichever side (above/below) is
// closer. 'above' clusters are dominantly short liquidations by construction
// of the liquidation-price math (they sit above entry price); 'below' are
// dominantly long liquidations.
function nearestClusterInfo(currentPrice, confirmedClusters) {
  const above = confirmedClusters.filter((c) => c.price > currentPrice).sort((a, b) => a.price - b.price)[0]
  const below = confirmedClusters.filter((c) => c.price < currentPrice).sort((a, b) => b.price - a.price)[0]
  const aboveDistPct = above ? (above.price - currentPrice) / currentPrice : Infinity
  const belowDistPct = below ? (currentPrice - below.price) / currentPrice : Infinity
  if (aboveDistPct === Infinity && belowDistPct === Infinity) return null
  return aboveDistPct <= belowDistPct
    ? { distPct: aboveDistPct, side: 'above', windowsConfirmedIn: above.windowsConfirmedIn }
    : { distPct: belowDistPct, side: 'below', windowsConfirmedIn: below.windowsConfirmedIn }
}

// The original scoreLiquidationClusters rule scored every tick while price
// stayed within PROXIMITY_PCT of a cluster -- with 15-min ticks and clusters
// that don't move fast, that's dozens of near-duplicate, heavily
// autocorrelated firings per approach, drowning out whatever the real
// reaction at first contact was. This instead finds first-touch events (the
// tick price crosses INTO proximity, not every tick it stays there) and
// tests two competing hypotheses against two outcome horizons, split by
// confirmation strength:
//   - magnet: cluster pulls price through it (continuation) -- the original
//     assumption.
//   - reversal: cluster acts as support/resistance, price bounces off it
//     (a "stop hunt" pattern -- price wicks in, liquidations provide
//     counter-liquidity, price reverses).
function backtestLiquidationTouchEvents(snapshots) {
  const longestWindowMs = Math.max(...CLUSTER_WINDOWS_HOURS) * 60 * 60 * 1000
  const firstT = new Date(snapshots[0].fetched_at).getTime()
  const lastT = new Date(snapshots[snapshots.length - 1].fetched_at).getTime()

  let prevNear = false
  const events = []

  for (let i = 0; i < snapshots.length; i++) {
    const t = new Date(snapshots[i].fetched_at).getTime()
    if (t - firstT < longestWindowMs) continue // not enough prior history yet

    const heatmaps = CLUSTER_WINDOWS_HOURS.map((hours) =>
      computeLiquidationHeatmap(windowSlice(snapshots, i, hours), snapshots[i].mark_price)
    )
    const clusters = findConfirmedClusters(heatmaps, snapshots[i].mark_price)
    const info = nearestClusterInfo(snapshots[i].mark_price, clusters)
    const isNear = !!info && info.distPct <= PROXIMITY_PCT

    if (isNear && !prevNear) {
      events.push({ time: t, price: snapshots[i].mark_price, side: info.side, windowsConfirmedIn: info.windowsConfirmedIn })
    }
    prevNear = isNear
  }

  console.log(
    `\n=== Liquidation cluster touch-event backtest (${events.length} first-touch events over ~${((lastT - firstT) / 86400000).toFixed(1)} days) ===`
  )
  if (events.length === 0) {
    console.log('  No touch events -- proximity threshold may be too tight, or clusters rarely confirm near price.')
    return
  }

  for (const horizonHours of [SHORT_WINDOW_HOURS, WINDOW_HOURS]) {
    console.log(`  -- ${horizonHours}h outcome --`)
    for (const hypothesis of ['magnet', 'reversal']) {
      for (const minConfirm of [2, 3]) {
        const subset = events.filter((e) => e.windowsConfirmedIn >= minConfirm)
        const trades = []
        for (const e of subset) {
          const outcomeIndex = snapshots.findIndex(
            (s) => new Date(s.fetched_at).getTime() >= e.time + horizonHours * 60 * 60 * 1000
          )
          if (outcomeIndex === -1) continue

          const magnetDirection = e.side === 'above' ? 'bullish' : 'bearish'
          const signal = hypothesis === 'magnet' ? magnetDirection : magnetDirection === 'bullish' ? 'bearish' : 'bullish'
          const { correct, priceChangePct } = evaluateOutcome(signal, e.price, snapshots[outcomeIndex].mark_price)
          const tradeReturnPct = signal === 'bearish' ? -priceChangePct : priceChangePct
          const netReturnPct = tradeReturnPct - ROUND_TRIP_FEE_PCT
          trades.push({ correct, tradeReturnPct, netReturnPct })
        }

        if (trades.length < MIN_COMBO_SAMPLE) continue
        const wins = trades.filter((t) => t.correct).length
        const avgNet = trades.reduce((s, t) => s + t.netReturnPct, 0) / trades.length
        const avgGross = trades.reduce((s, t) => s + t.tradeReturnPct, 0) / trades.length
        console.log(
          `     [${hypothesis}, ${minConfirm}/3+ confirm] n=${trades.length} | win rate ${((wins / trades.length) * 100).toFixed(1)}% | gross ${avgGross >= 0 ? '+' : ''}${avgGross.toFixed(3)}% | NET ${avgNet >= 0 ? '+' : ''}${avgNet.toFixed(3)}%`
        )
      }
    }
  }
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

    const { signal, rules, combo } = evaluateFn(window)
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
    const netReturnPct = tradeReturnPct - ROUND_TRIP_FEE_PCT
    results.push({ signal, correct, rules, tradeReturnPct, netReturnPct, combo })
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
  reportCombinations(results, 'bullish')
  reportCombinations(results, 'bearish')
}

// Expectancy: the average return per trade if every call were acted on with
// equal size, no leverage. Gross is before fees; net subtracts an estimated
// round-trip taker fee (funding payments and slippage still excluded, so
// real-world net is likely somewhat worse than this). Gross accuracy alone
// doesn't say whether a signal makes money -- a high win rate with tiny wins
// and large losses can still lose, and this is what actually answers that.
function reportExpectancy(results, signalType) {
  const trades = results.filter((r) => r.signal === signalType)
  if (trades.length === 0) return

  const wins = trades.filter((t) => t.tradeReturnPct > 0)
  const losses = trades.filter((t) => t.tradeReturnPct <= 0)
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.tradeReturnPct, 0) / wins.length : 0
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.tradeReturnPct, 0) / losses.length : 0
  const avgReturn = trades.reduce((s, t) => s + t.tradeReturnPct, 0) / trades.length
  const avgNetReturn = trades.reduce((s, t) => s + t.netReturnPct, 0) / trades.length
  const netWinRate = (trades.filter((t) => t.netReturnPct > 0).length / trades.length) * 100
  const winRate = (wins.length / trades.length) * 100

  console.log(`  -- ${signalType} expectancy (no leverage, equal size) --`)
  console.log(`     gross win rate: ${winRate.toFixed(1)}% (${wins.length}/${trades.length})`)
  console.log(`     gross avg win: +${avgWin.toFixed(3)}%   avg loss: ${avgLoss.toFixed(3)}%`)
  console.log(`     gross average return per trade: ${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(3)}%`)
  console.log(
    `     NET (after ~${ROUND_TRIP_FEE_PCT.toFixed(2)}% round-trip fee) win rate: ${netWinRate.toFixed(1)}%, avg return: ${avgNetReturn >= 0 ? '+' : ''}${avgNetReturn.toFixed(3)}%`
  )
}

// Which specific rule combinations, when they're what's actually driving a
// call, have real proven edge -- vs. which just happen to co-occur without
// adding anything. Filtered to combos with enough samples to mean something.
function reportCombinations(results, signalType) {
  const trades = results.filter((r) => r.signal === signalType)
  if (trades.length === 0) return

  const byCombo = {}
  for (const t of trades) {
    byCombo[t.combo] = byCombo[t.combo] || []
    byCombo[t.combo].push(t)
  }

  const rows = Object.entries(byCombo)
    .filter(([, group]) => group.length >= MIN_COMBO_SAMPLE)
    .map(([combo, group]) => {
      const winRate = (group.filter((t) => t.correct).length / group.length) * 100
      const avgNetReturn = group.reduce((s, t) => s + t.netReturnPct, 0) / group.length
      return { combo, count: group.length, winRate, avgNetReturn }
    })
    .sort((a, b) => b.avgNetReturn - a.avgNetReturn)

  if (rows.length === 0) {
    console.log(`  -- ${signalType} combinations: none with >= ${MIN_COMBO_SAMPLE} samples --`)
    return
  }

  console.log(`  -- ${signalType} combinations by net expectancy (min ${MIN_COMBO_SAMPLE} samples) --`)
  for (const r of rows) {
    console.log(
      `     [${r.avgNetReturn >= 0 ? '+' : ''}${r.avgNetReturn.toFixed(3)}% net/trade] ${r.combo} (n=${r.count}, ${r.winRate.toFixed(1)}% win rate)`
    )
  }
}

// Direct test of the underlying assumption behind price_momentum/oi_momentum:
// does a fast move CONTINUE (the rule's current assumption) or REVERSE over
// the next hour? Standalone (not combined with taker_flow or gated by
// volatility) so this isolates exactly what the raw momentum reading itself
// is worth, before deciding how -- or whether -- to fix the live rule.
function backtestMomentumHypotheses(snapshots) {
  const priceTrades = { continuation: [], reversal: [] }
  const oiTrades = { continuation: [], reversal: [] }

  const record = (bucket, continuationSignal, evalTime, entryPrice) => {
    const outcomeIndex = snapshots.findIndex(
      (s) => new Date(s.fetched_at).getTime() >= evalTime + SHORT_WINDOW_HOURS * 60 * 60 * 1000
    )
    if (outcomeIndex === -1) return
    const reversalSignal = continuationSignal === 'bullish' ? 'bearish' : 'bullish'
    for (const [key, signal] of [['continuation', continuationSignal], ['reversal', reversalSignal]]) {
      const { correct, priceChangePct } = evaluateOutcome(signal, entryPrice, snapshots[outcomeIndex].mark_price)
      const tradeReturnPct = signal === 'bearish' ? -priceChangePct : priceChangePct
      const netReturnPct = tradeReturnPct - ROUND_TRIP_FEE_PCT
      bucket[key].push({ correct, tradeReturnPct, netReturnPct })
    }
  }

  for (let i = 0; i < snapshots.length; i++) {
    const window = windowSlice(snapshots, i, SHORT_WINDOW_HOURS)
    if (window.length < 2) continue

    const earliest = window[0]
    const latest = window[window.length - 1]
    const priceChangePct = ((latest.mark_price - earliest.mark_price) / earliest.mark_price) * 100
    const oiChangePct = ((latest.open_interest - earliest.open_interest) / earliest.open_interest) * 100
    const evalTime = new Date(snapshots[i].fetched_at).getTime()

    if (Math.abs(priceChangePct) > 0.25) {
      record(priceTrades, priceChangePct > 0 ? 'bullish' : 'bearish', evalTime, snapshots[i].mark_price)
    }
    if (Math.abs(oiChangePct) > 1) {
      record(oiTrades, oiChangePct > 0 ? 'bullish' : 'bearish', evalTime, snapshots[i].mark_price)
    }
  }

  const report = (label, trades) => {
    console.log(`\n=== ${label} standalone hypothesis test (1h outcome, unfiltered by volatility) ===`)
    for (const key of ['continuation', 'reversal']) {
      const t = trades[key]
      if (t.length === 0) {
        console.log(`  ${key}: never fired`)
        continue
      }
      const wins = t.filter((x) => x.correct).length
      const avgNet = t.reduce((s, x) => s + x.netReturnPct, 0) / t.length
      const avgGross = t.reduce((s, x) => s + x.tradeReturnPct, 0) / t.length
      console.log(
        `  ${key}: n=${t.length} | win rate ${((wins / t.length) * 100).toFixed(1)}% | gross ${avgGross >= 0 ? '+' : ''}${avgGross.toFixed(3)}% | NET ${avgNet >= 0 ? '+' : ''}${avgNet.toFixed(3)}%`
      )
    }
  }

  report('price_momentum', priceTrades)
  report('oi_momentum', oiTrades)
}

// oi_momentum's continuation reading (its current, unchanged direction) came
// back close to profitable (61.6% win rate, gross +0.092%, net just -0.008%
// after fees) at the existing >1% threshold -- worth checking whether a
// stricter threshold (fewer, higher-conviction signals) tips it net-positive.
function backtestOiMomentumThresholds(snapshots) {
  const thresholds = [1, 1.5, 2, 2.5, 3]
  const byThreshold = Object.fromEntries(thresholds.map((t) => [t, []]))

  for (let i = 0; i < snapshots.length; i++) {
    const window = windowSlice(snapshots, i, SHORT_WINDOW_HOURS)
    if (window.length < 2) continue

    const earliest = window[0]
    const latest = window[window.length - 1]
    const oiChangePct = ((latest.open_interest - earliest.open_interest) / earliest.open_interest) * 100
    const absChange = Math.abs(oiChangePct)
    const evalTime = new Date(snapshots[i].fetched_at).getTime()

    const outcomeIndex = snapshots.findIndex(
      (s) => new Date(s.fetched_at).getTime() >= evalTime + SHORT_WINDOW_HOURS * 60 * 60 * 1000
    )
    if (outcomeIndex === -1) continue

    for (const threshold of thresholds) {
      if (absChange <= threshold) continue
      const signal = oiChangePct > 0 ? 'bullish' : 'bearish'
      const { correct, priceChangePct } = evaluateOutcome(signal, snapshots[i].mark_price, snapshots[outcomeIndex].mark_price)
      const tradeReturnPct = signal === 'bearish' ? -priceChangePct : priceChangePct
      const netReturnPct = tradeReturnPct - ROUND_TRIP_FEE_PCT
      byThreshold[threshold].push({ correct, tradeReturnPct, netReturnPct })
    }
  }

  console.log(`\n=== oi_momentum threshold sweep (continuation, 1h outcome) ===`)
  for (const threshold of thresholds) {
    const t = byThreshold[threshold]
    if (t.length < MIN_COMBO_SAMPLE) {
      console.log(`  >${threshold}%: n=${t.length} (below min sample)`)
      continue
    }
    const wins = t.filter((x) => x.correct).length
    const avgNet = t.reduce((s, x) => s + x.netReturnPct, 0) / t.length
    const avgGross = t.reduce((s, x) => s + x.tradeReturnPct, 0) / t.length
    console.log(
      `  >${threshold}%: n=${t.length} | win rate ${((wins / t.length) * 100).toFixed(1)}% | gross ${avgGross >= 0 ? '+' : ''}${avgGross.toFixed(3)}% | NET ${avgNet >= 0 ? '+' : ''}${avgNet.toFixed(3)}%`
    )
  }
}

// Tests requiring the 4h and 1h signals to agree (or at least not conflict)
// before trusting the 1h call -- a classic multi-timeframe confluence
// filter. If the 4h read is bullish/bearish and disagrees with a fired 1h
// signal, that's a reason to distrust the shorter-term read; if 4h agrees or
// is neutral, that's either confirmation or "no opinion." This only re-scores
// the 1h PROVEN_COMBOS calls (fear_greed+taker_flow, oi_momentum+taker_flow)
// since those are the only ones actually worth trusting to begin with.
function backtestConfluence(snapshots) {
  const PROVEN_1H = new Set(['fear_greed+taker_flow', 'oi_momentum+taker_flow'])
  const buckets = { aligned: [], neutral4h: [], conflicting: [] }

  for (let i = 0; i < snapshots.length; i++) {
    const window1h = windowSlice(snapshots, i, SHORT_WINDOW_HOURS)
    const window4h = windowSlice(snapshots, i, WINDOW_HOURS)
    if (window1h.length < 2 || window4h.length < 2) continue

    const short = evaluateShortTermSignal(window1h)
    if (short.signal === 'neutral' || !PROVEN_1H.has(short.combo)) continue

    const structural = evaluateSignal(window4h)
    const evaluatedAtMs = new Date(snapshots[i].fetched_at).getTime()
    const outcomeIndex = snapshots.findIndex(
      (s) => new Date(s.fetched_at).getTime() >= evaluatedAtMs + SHORT_WINDOW_HOURS * 60 * 60 * 1000
    )
    if (outcomeIndex === -1) continue

    const { correct, priceChangePct } = evaluateOutcome(short.signal, snapshots[i].mark_price, snapshots[outcomeIndex].mark_price)
    const tradeReturnPct = short.signal === 'bearish' ? -priceChangePct : priceChangePct
    const netReturnPct = tradeReturnPct - ROUND_TRIP_FEE_PCT
    const trade = { correct, tradeReturnPct, netReturnPct }

    if (structural.signal === 'neutral') buckets.neutral4h.push(trade)
    else if (structural.signal === short.signal) buckets.aligned.push(trade)
    else buckets.conflicting.push(trade)
  }

  console.log(`\n=== Multi-timeframe confluence test (1h PROVEN_COMBOS calls only, split by what 4h says at the same moment) ===`)
  for (const [label, trades] of Object.entries(buckets)) {
    if (trades.length === 0) {
      console.log(`  ${label}: never occurred`)
      continue
    }
    const wins = trades.filter((t) => t.correct).length
    const avgNet = trades.reduce((s, t) => s + t.netReturnPct, 0) / trades.length
    const avgGross = trades.reduce((s, t) => s + t.tradeReturnPct, 0) / trades.length
    console.log(
      `  ${label}: n=${trades.length} | win rate ${((wins / trades.length) * 100).toFixed(1)}% | gross ${avgGross >= 0 ? '+' : ''}${avgGross.toFixed(3)}% | NET ${avgNet >= 0 ? '+' : ''}${avgNet.toFixed(3)}%`
    )
  }
}

const CLUSTER_LONGEST_WINDOW_MS = Math.max(...CLUSTER_WINDOWS_HOURS) * 60 * 60 * 1000
const VETO_MIN_CONFIRM = 3 // only the tier that showed real signal in the touch-event backtest

// Whether a strongly-confirmed (3/3) cluster sits in the direction the trade
// needs price to move -- above current price for a bullish call, below for a
// bearish one -- within the same PROXIMITY_PCT used elsewhere. Returns null
// if there isn't yet enough prior history (168h) to compute clusters at all.
function clusterInTheWay(snapshots, i, firstT, signal) {
  const t = new Date(snapshots[i].fetched_at).getTime()
  if (t - firstT < CLUSTER_LONGEST_WINDOW_MS) return null

  const heatmaps = CLUSTER_WINDOWS_HOURS.map((hours) =>
    computeLiquidationHeatmap(windowSlice(snapshots, i, hours), snapshots[i].mark_price)
  )
  const clusters = findConfirmedClusters(heatmaps, snapshots[i].mark_price).filter(
    (c) => c.windowsConfirmedIn >= VETO_MIN_CONFIRM
  )
  const price = snapshots[i].mark_price

  if (signal === 'bullish') {
    return clusters.some((c) => c.price > price && (c.price - price) / price <= PROXIMITY_PCT)
  }
  return clusters.some((c) => c.price < price && (price - c.price) / price <= PROXIMITY_PCT)
}

// Tests the veto idea: split each timeframe's PROVEN_COMBOS calls by whether
// a strongly-confirmed liquidation cluster sat between current price and
// where the trade needs price to go. If clusters really do act as
// support/resistance (per the touch-event backtest), a proven call with a
// wall in its path should underperform one with a clear path.
function backtestLiquidationVeto(snapshots) {
  const firstT = new Date(snapshots[0].fetched_at).getTime()
  const configs = [
    { label: '4h', windowHours: WINDOW_HOURS, evaluateFn: evaluateSignal },
    { label: '1h', windowHours: SHORT_WINDOW_HOURS, evaluateFn: evaluateShortTermSignal },
  ]

  for (const { label, windowHours, evaluateFn } of configs) {
    const buckets = { clear: [], obstructed: [] }
    let unknown = 0

    for (let i = 0; i < snapshots.length; i++) {
      const window = windowSlice(snapshots, i, windowHours)
      if (window.length < 2) continue

      const { signal, combo } = evaluateFn(window)
      if (signal === 'neutral') continue
      const proven = (PROVEN_COMBOS[label]?.[signal] ?? []).includes(combo)
      if (!proven) continue

      const inTheWay = clusterInTheWay(snapshots, i, firstT, signal)
      if (inTheWay === null) {
        unknown++
        continue
      }

      const evaluatedAtMs = new Date(snapshots[i].fetched_at).getTime()
      const outcomeIndex = snapshots.findIndex(
        (s) => new Date(s.fetched_at).getTime() >= evaluatedAtMs + windowHours * 60 * 60 * 1000
      )
      if (outcomeIndex === -1) continue

      const { correct, priceChangePct } = evaluateOutcome(signal, snapshots[i].mark_price, snapshots[outcomeIndex].mark_price)
      const tradeReturnPct = signal === 'bearish' ? -priceChangePct : priceChangePct
      const netReturnPct = tradeReturnPct - ROUND_TRIP_FEE_PCT
      ;(inTheWay ? buckets.obstructed : buckets.clear).push({ correct, tradeReturnPct, netReturnPct })
    }

    console.log(
      `\n=== Liquidation-cluster veto test: ${label} proven-combo calls, split by whether a 3/3 cluster sat in the trade's path ===`
    )
    for (const key of ['clear', 'obstructed']) {
      const trades = buckets[key]
      if (trades.length === 0) {
        console.log(`  ${key}: never occurred`)
        continue
      }
      const wins = trades.filter((t) => t.correct).length
      const avgNet = trades.reduce((s, t) => s + t.netReturnPct, 0) / trades.length
      const avgGross = trades.reduce((s, t) => s + t.tradeReturnPct, 0) / trades.length
      console.log(
        `  ${key}: n=${trades.length} | win rate ${((wins / trades.length) * 100).toFixed(1)}% | gross ${avgGross >= 0 ? '+' : ''}${avgGross.toFixed(3)}% | NET ${avgNet >= 0 ? '+' : ''}${avgNet.toFixed(3)}%`
      )
    }
    if (unknown > 0) console.log(`  (${unknown} proven fires skipped -- not enough cluster history yet)`)
  }
}

// Exhaustively checks every PAIR of rules that fire in the same direction on
// the same tick, regardless of whether the total score actually crossed the
// +-2 threshold (i.e. even if a third rule fired the opposite way and
// cancelled it out to neutral). reportCombinations only ever sees the exact
// full set of rules that fired together as one whole "combo" AND crossed the
// threshold -- this is more exhaustive, meant to surface a 2-rule
// relationship with real edge that today's scoring might be diluting by
// requiring the rest of the rule set to also cooperate.
function backtestPairwiseCombos(snapshots) {
  const configs = [
    { label: '4h', windowHours: WINDOW_HOURS, evaluateFn: evaluateSignal },
    { label: '1h', windowHours: SHORT_WINDOW_HOURS, evaluateFn: evaluateShortTermSignal },
  ]

  for (const { label, windowHours, evaluateFn } of configs) {
    const pairStats = {}

    for (let i = 0; i < snapshots.length; i++) {
      const window = windowSlice(snapshots, i, windowHours)
      if (window.length < 2) continue

      const { rules } = evaluateFn(window)
      const fired = rules.filter((r) => r.score !== 0)
      if (fired.length < 2) continue

      const evaluatedAtMs = new Date(snapshots[i].fetched_at).getTime()
      const outcomeIndex = snapshots.findIndex(
        (s) => new Date(s.fetched_at).getTime() >= evaluatedAtMs + windowHours * 60 * 60 * 1000
      )
      if (outcomeIndex === -1) continue

      for (let a = 0; a < fired.length; a++) {
        for (let b = a + 1; b < fired.length; b++) {
          const ruleA = fired[a]
          const ruleB = fired[b]
          if (Math.sign(ruleA.score) !== Math.sign(ruleB.score)) continue

          const direction = ruleA.score > 0 ? 'bullish' : 'bearish'
          const key = [ruleA.rule, ruleB.rule].sort().join('+')

          const { correct, priceChangePct } = evaluateOutcome(direction, snapshots[i].mark_price, snapshots[outcomeIndex].mark_price)
          const tradeReturnPct = direction === 'bearish' ? -priceChangePct : priceChangePct
          const netReturnPct = tradeReturnPct - ROUND_TRIP_FEE_PCT

          pairStats[key] = pairStats[key] || { bullish: [], bearish: [] }
          pairStats[key][direction].push({ correct, tradeReturnPct, netReturnPct })
        }
      }
    }

    console.log(
      `\n=== Pairwise rule-combo mining: ${label} (any 2 rules firing the same direction, regardless of total score threshold) ===`
    )
    const rows = []
    for (const [key, byDir] of Object.entries(pairStats)) {
      for (const direction of ['bullish', 'bearish']) {
        const trades = byDir[direction]
        if (trades.length < MIN_COMBO_SAMPLE) continue
        const wins = trades.filter((t) => t.correct).length
        const avgNet = trades.reduce((s, t) => s + t.netReturnPct, 0) / trades.length
        rows.push({ key, direction, count: trades.length, winRate: (wins / trades.length) * 100, avgNet })
      }
    }
    rows.sort((a, b) => b.avgNet - a.avgNet)
    if (rows.length === 0) {
      console.log(`  no pairs with >= ${MIN_COMBO_SAMPLE} samples`)
      continue
    }
    for (const r of rows) {
      console.log(
        `  [${r.avgNet >= 0 ? '+' : ''}${r.avgNet.toFixed(3)}% net/trade] ${r.key} (${r.direction}, n=${r.count}, ${r.winRate.toFixed(1)}% win rate)`
      )
    }
  }
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
  backtestLiquidationTouchEvents(snapshots)
  backtestMomentumHypotheses(snapshots)
  backtestOiMomentumThresholds(snapshots)
  backtestConfluence(snapshots)
  backtestLiquidationVeto(snapshots)
  backtestPairwiseCombos(snapshots)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
