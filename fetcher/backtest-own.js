// Backtests the CURRENT signal rules against our own stored market_snapshots
// (collected every 15min since 2026-08-04) instead of Binance's history,
// which caps open interest at 30 days. Our history keeps growing, so every
// rerun has a bigger sample than the last.
//
// Unlike backtest.js (which only compares price at signal time vs. 4h later),
// this walks the real intra-window price path from Bitget 15m candles, so it
// knows whether TP or SL would actually have been touched first.
//
// Caveat: snapshot fields added later (fear/greed, gold, basis, top trader)
// are null in early rows, so rules depending on them score 0 there -- the
// replay sees exactly what the live system would have had at that moment.
//
// Usage: node backtest-own.js
import { config } from 'dotenv'
config({ quiet: true })
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  evaluateSignal,
  evaluateShortTermSignal,
  suggestTradeLevels,
  WINDOW_HOURS,
  SHORT_WINDOW_HOURS,
} from './src/signal.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(__dirname, '.backtest-cache')
const SYMBOL = 'BTCUSDT'
const BAR_MS = 15 * 60 * 1000
// Bitget futures taker fee (0.06%) on entry and exit -- what our trades pay.
const ROUND_TRIP_FEE_PCT = 0.12
const MIN_ALERTS = 3
const TP_SWEEP = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0]
const SL_SWEEP = [-0.3, -0.5, -0.75, -1.0]

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env

async function loadSnapshots() {
  const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
  const rows = []
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/market_snapshots?select=*&symbol=eq.${SYMBOL}&order=fetched_at.asc&offset=${offset}&limit=1000`,
      { headers }
    )
    const page = await res.json()
    if (!res.ok) throw new Error(`Supabase snapshots query failed: ${JSON.stringify(page)}`)
    rows.push(...page)
    if (page.length < 1000) break
  }
  return rows
}

async function loadStoredSignals() {
  const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
  const rows = []
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/signals?select=timeframe,evaluated_at,signal,combo&symbol=eq.${SYMBOL}&order=evaluated_at.asc&offset=${offset}&limit=1000`,
      { headers }
    )
    const page = await res.json()
    if (!res.ok) throw new Error(`Supabase signals query failed: ${JSON.stringify(page)}`)
    rows.push(...page)
    if (page.length < 1000) break
  }
  return rows
}

// Bitget 15m candles (the exchange we actually trade on), paginated backwards.
// Cached by day so reruns only fetch what's new.
async function loadCandles(startMs) {
  const cachePath = join(CACHE_DIR, 'bitget-15m.json')
  let candles = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : []
  const haveFrom = candles.length ? candles[0].t : Infinity
  const haveTo = candles.length ? candles[candles.length - 1].t : -Infinity

  const fetchRange = async (fromMs, toMs) => {
    const out = []
    let end = toMs
    while (end > fromMs) {
      const res = await fetch(
        `https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${SYMBOL}&productType=USDT-FUTURES&granularity=15m&limit=200&endTime=${end}`
      )
      const json = await res.json()
      if (!json.data?.length) break
      out.push(...json.data.map((c) => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] })))
      end = Math.min(...json.data.map((c) => +c[0])) - 1
      await new Promise((r) => setTimeout(r, 150))
    }
    return out
  }

  if (startMs < haveFrom) candles.push(...(await fetchRange(startMs - BAR_MS, Math.min(haveFrom, Date.now()))))
  candles.push(...(await fetchRange(Math.max(haveTo, startMs), Date.now())))
  candles = [...new Map(candles.map((c) => [c.t, c])).values()].sort((a, b) => a.t - b.t)
  // Drop the still-forming last bar so it's never cached as final.
  candles = candles.filter((c) => c.t + BAR_MS <= Date.now())

  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cachePath, JSON.stringify(candles))
  return candles
}

// Replays one timeframe the way run.js does live: window = every snapshot
// with fetched_at >= now - windowHours. A "new alert" is a non-neutral
// signal that differs from the previous tick's (same rule run.js alerts on).
// For 1h, a proven call the 4h signal already agrees with is downgraded to
// experimental, mirroring run.js's concurrentSignal rule.
function replay(snapshots, windowHours, evaluateFn, concurrent = null) {
  const out = []
  let start = 0
  let previous = null
  for (let i = 0; i < snapshots.length; i++) {
    const t = snapshots[i].t
    while (snapshots[start].t < t - windowHours * 3600e3) start++
    const window = snapshots.slice(start, i + 1)
    if (window.length < 2) continue
    const { signal, combo, confidence: base } = evaluateFn(window)
    const confidence = base === 'proven' && concurrent?.[i] === signal ? 'experimental' : base
    out.push({ i, t, signal, combo, confidence, isNewAlert: signal !== 'neutral' && signal !== previous })
    previous = signal
  }
  return out
}

function buildPath(candles, candleIndexByT, entryT, entryPrice, hours, long) {
  const first = candleIndexByT.get(Math.floor(entryT / BAR_MS) * BAR_MS)
  if (first == null) return null
  // Start at the NEXT bar: the bar containing entryT may have printed its
  // high/low before the signal existed.
  const bars = candles.slice(first + 1, first + 1 + hours * 4)
  if (bars.length < hours * 4) return null
  const sign = long ? 1 : -1
  return {
    bars: bars.map((b) => {
      const hi = (b.h / entryPrice - 1) * 100
      const lo = (b.l / entryPrice - 1) * 100
      return long ? { fav: hi, adv: lo } : { fav: -lo, adv: -hi }
    }),
    close: (bars[bars.length - 1].c / entryPrice - 1) * 100 * sign,
  }
}

// TP/SL in signed % (tp > 0, sl < 0). If both are touched inside the same
// 15m bar we can't know which came first, so assume SL (conservative).
function simulate(path, tp, sl) {
  for (const b of path.bars) {
    if (b.adv <= sl) return { r: sl, how: 'SL' }
    if (b.fav >= tp) return { r: tp, how: 'TP' }
  }
  return { r: path.close, how: 'TIME' }
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN)
const median = (a) => {
  if (!a.length) return NaN
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor((s.length - 1) / 2)]
}
const pct = (x, d = 3) => (Number.isNaN(x) ? '   n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`)

function stats(trades, tp, sl) {
  const res = trades.map((t) => simulate(t.path, tp, sl))
  const net = res.map((r) => r.r - ROUND_TRIP_FEE_PCT)
  return {
    n: trades.length,
    tpHits: res.filter((r) => r.how === 'TP').length,
    slHits: res.filter((r) => r.how === 'SL').length,
    netAvg: avg(net),
    netTotal: net.reduce((s, x) => s + x, 0),
  }
}

async function main() {
  console.log('Loading snapshots from Supabase...')
  const raw = await loadSnapshots()
  const snapshots = raw.map((s) => ({ ...s, t: Date.parse(s.fetched_at) }))
  console.log(`  ${snapshots.length} snapshots, ${snapshots[0].fetched_at} -> ${snapshots[snapshots.length - 1].fetched_at}`)

  console.log('Loading Bitget 15m candles...')
  const candles = await loadCandles(snapshots[0].t)
  const candleIndexByT = new Map(candles.map((c, i) => [c.t, i]))
  console.log(`  ${candles.length} candles`)

  const r4h = replay(snapshots, WINDOW_HOURS, evaluateSignal)
  const signal4hBySnapshot = Object.fromEntries(r4h.map((r) => [r.i, r.signal]))
  const r1h = replay(snapshots, SHORT_WINDOW_HOURS, evaluateShortTermSignal, signal4hBySnapshot)

  // Sanity check: does the replay reproduce what the live system stored?
  // Mismatches are expected where rules changed after the signal was saved.
  const stored = await loadStoredSignals()
  const storedByKey = new Map(stored.map((s) => [`${s.timeframe}|${Math.round(Date.parse(s.evaluated_at) / 60000)}`, s]))
  for (const [tf, rows] of [['4h', r4h], ['1h', r1h]]) {
    let compared = 0
    let same = 0
    const recentCutoff = Date.now() - 14 * 24 * 3600e3
    let recentCompared = 0
    let recentSame = 0
    for (const r of rows) {
      const s = storedByKey.get(`${tf}|${Math.round(snapshots[r.i].t / 60000)}`)
      if (!s) continue
      compared++
      const match = s.signal === r.signal
      if (match) same++
      if (r.t >= recentCutoff) {
        recentCompared++
        if (match) recentSame++
      }
    }
    console.log(
      `  replay vs stored ${tf}: ${((100 * same) / compared).toFixed(1)}% match overall (n=${compared}), ${((100 * recentSame) / recentCompared).toFixed(1)}% in the last 14 days (n=${recentCompared})`
    )
  }

  const midT = snapshots[0].t + (snapshots[snapshots.length - 1].t - snapshots[0].t) / 2
  console.log(`\nFees: ${ROUND_TRIP_FEE_PCT}% round trip. Halves split at ${new Date(midT).toISOString().slice(0, 10)}.`)

  for (const [tf, hours, rows] of [['4h', WINDOW_HOURS, r4h], ['1h', SHORT_WINDOW_HOURS, r1h]]) {
    const groups = {}
    for (const r of rows) {
      if (!r.isNewAlert) continue
      const snap = snapshots[r.i]
      const path = buildPath(candles, candleIndexByT, r.t, snap.mark_price, hours, r.signal === 'bullish')
      if (!path) continue
      const key = `${r.signal} ${r.combo}`
      groups[key] = groups[key] || { signal: r.signal, combo: r.combo, proven: false, trades: [] }
      if (r.confidence === 'proven') groups[key].proven = true
      groups[key].trades.push({ t: r.t, entry: snap.mark_price, path })
    }

    const sorted = Object.values(groups)
      .filter((g) => g.trades.length >= MIN_ALERTS)
      .sort((a, b) => b.trades.length - a.trades.length)

    console.log(`\n================ ${tf} combos (>= ${MIN_ALERTS} alerts) ================`)
    for (const g of sorted) {
      const { trades } = g
      const closes = trades.map((t) => t.path.close)
      const mfe = trades.map((t) => Math.max(...t.path.bars.map((b) => b.fav)))
      const mae = trades.map((t) => Math.min(...t.path.bars.map((b) => b.adv)))
      const winsAtClose = closes.filter((c) => c > 0).length

      console.log(`\n${tf} ${g.signal.toUpperCase()} ${g.combo}${g.proven ? '  [PROVEN]' : ''}`)
      console.log(
        `  alerts ${trades.length} | right direction at ${tf} close: ${((100 * winsAtClose) / trades.length).toFixed(0)}% | avg close ${pct(avg(closes))} | median close ${pct(median(closes))}`
      )
      console.log(`  best move inside window (median) ${pct(median(mfe), 2)} | worst move (median) ${pct(median(mae), 2)}`)

      const levels = suggestTradeLevels(tf, g.signal, g.combo, 100)
      if (levels) {
        const s = stats(trades, levels.avgWinPct, levels.avgLossPct)
        const first = stats(trades.filter((t) => t.t < midT), levels.avgWinPct, levels.avgLossPct)
        const second = stats(trades.filter((t) => t.t >= midT), levels.avgWinPct, levels.avgLossPct)
        console.log(
          `  CURRENT levels TP +${levels.avgWinPct}% / SL ${levels.avgLossPct}%: TP hit ${s.tpHits}/${s.n}, SL hit ${s.slHits}/${s.n}, net/trade ${pct(s.netAvg)}, total ${pct(s.netTotal, 2)}`
        )
        console.log(
          `    1st half: n=${first.n}, net/trade ${pct(first.netAvg)}  |  2nd half: n=${second.n}, net/trade ${pct(second.netAvg)}`
        )
      }

      // Best TP/SL grid -- in-sample, so it flatters the result; use it to
      // spot combos worth a closer look, not as levels to trade directly.
      let best = null
      for (const tp of TP_SWEEP) {
        for (const sl of SL_SWEEP) {
          const s = stats(trades, tp, sl)
          if (!best || s.netAvg > best.netAvg) best = { ...s, tp, sl }
        }
      }
      console.log(
        `  best grid TP +${best.tp}% / SL ${best.sl}% (in-sample): TP hit ${best.tpHits}/${best.n}, net/trade ${pct(best.netAvg)}`
      )
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
