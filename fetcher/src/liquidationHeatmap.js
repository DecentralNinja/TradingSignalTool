// Estimates where leveraged positions would get liquidated, using the same
// approach CoinGlass documents for their own heatmap: open interest snapshots
// + an assumed leverage distribution run through standard liquidation-price
// math -- not real liquidation events (Binance's own liquidation WebSocket
// showed zero activity across five separate multi-hour tests, so this
// sidesteps that entirely -- see fetcher/backtest.js history).
//
// LEVERAGE_TIERS is an assumption about how retail leverage usage is
// distributed on Binance BTC futures, not verified data -- CoinGlass
// calibrates theirs from broader cross-exchange data we don't have access
// to. Treat this as a starting guess pending backtested validation, same as
// every other threshold in this project.
export const LEVERAGE_TIERS = [
  { leverage: 5, weight: 0.1 },
  { leverage: 10, weight: 0.25 },
  { leverage: 20, weight: 0.25 },
  { leverage: 25, weight: 0.15 },
  { leverage: 50, weight: 0.15 },
  { leverage: 75, weight: 0.05 },
  { leverage: 100, weight: 0.05 },
]

// Bucket width as a fraction of price (0.5% buckets), so this scales with
// whatever price level BTC is actually at instead of a fixed dollar amount.
const BUCKET_PCT = 0.005

// Bucket width is a fixed dollar amount derived from referencePrice, held
// constant across one heatmap computation -- referencePrice must NOT be the
// price being bucketed itself, or every price collapses to the same bucket
// (price / (price * BUCKET_PCT) is referencePrice-independent by construction).
function bucketKey(price, referencePrice) {
  return Math.round(price / (referencePrice * BUCKET_PCT))
}

function bucketToPrice(key, referencePrice) {
  return key * (referencePrice * BUCKET_PCT)
}

// snapshots: ascending by fetched_at, each with mark_price, open_interest,
// long_short_ratio. referencePrice fixes the bucket grid (pass the latest
// snapshot's price) so buckets line up consistently across every estimated
// liquidation price, however far from current price it lands. Returns a Map
// of bucketKey -> { long, short } estimated notional mass, kept separate
// since a bucket above price is meaningfully different (mostly short
// liquidations) from one below (mostly long liquidations) -- merging them
// loses the directional read entirely.
export function computeLiquidationHeatmap(snapshots, referencePrice) {
  const heatmap = new Map()

  const addMass = (key, side, mass) => {
    const entry = heatmap.get(key) ?? { long: 0, short: 0 }
    entry[side] += mass
    heatmap.set(key, entry)
  }

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1]
    const curr = snapshots[i]
    const deltaOI = curr.open_interest - prev.open_interest
    if (deltaOI <= 0) continue // only rising OI represents freshly opened positions

    const ratio = curr.long_short_ratio ?? 1
    const longFraction = ratio / (1 + ratio)
    const shortFraction = 1 - longFraction
    const entryPrice = curr.mark_price

    for (const { leverage, weight } of LEVERAGE_TIERS) {
      const longLiqPrice = entryPrice * (1 - 1 / leverage)
      const shortLiqPrice = entryPrice * (1 + 1 / leverage)
      addMass(bucketKey(longLiqPrice, referencePrice), 'long', deltaOI * longFraction * weight)
      addMass(bucketKey(shortLiqPrice, referencePrice), 'short', deltaOI * shortFraction * weight)
    }
  }

  return heatmap
}

function totalMass(entry) {
  return entry.long + entry.short
}

// A cluster is "confirmed" when the same price bucket ranks in the top
// `topN` (by total mass) for at least `minWindows` of the supplied heatmaps
// (each computed over a different lookback window) -- the multi-timeframe
// agreement is what separates a real, persistent liquidity pool from an
// artifact of picking one arbitrary cutoff.
export function findConfirmedClusters(heatmapsByWindow, referencePrice, { topN = 10, minWindows = 2 } = {}) {
  const topKeysPerWindow = heatmapsByWindow.map((heatmap) => {
    return [...heatmap.entries()]
      .sort((a, b) => totalMass(b[1]) - totalMass(a[1]))
      .slice(0, topN)
      .map(([key]) => key)
  })

  const appearanceCount = new Map()
  for (const topKeys of topKeysPerWindow) {
    for (const key of topKeys) {
      appearanceCount.set(key, (appearanceCount.get(key) ?? 0) + 1)
    }
  }

  // Use the longest (last) window's mass breakdown to describe the cluster --
  // it's the most stable estimate since it averages over the most data.
  const referenceHeatmap = heatmapsByWindow[heatmapsByWindow.length - 1]

  const confirmed = [...appearanceCount.entries()]
    .filter(([, count]) => count >= minWindows)
    .map(([key, count]) => {
      const entry = referenceHeatmap.get(key) ?? { long: 0, short: 0 }
      const price = bucketToPrice(key, referencePrice)
      return {
        price,
        windowsConfirmedIn: count,
        // A cluster below price is dominantly long liquidations (they get
        // stopped out as price falls to them); above price, dominantly short
        // liquidations (stopped out as price rises to them) -- by construction
        // of the liquidation-price math, not just labeled by position.
        dominantSide: entry.long >= entry.short ? 'long' : 'short',
      }
    })
    .sort((a, b) => a.price - b.price)

  return confirmed
}

// Scores proximity to the nearest confirmed cluster above and below current
// price.
//
// Backtested via fetcher/backtest.js's touch-event replay (first-touch
// events only, not every tick spent nearby -- see that file for why). The
// original assumption here was "magnet": a cluster pulls price through it as
// stops get triggered. That tested WORSE than a coin flip (42-46% win rate
// on a 4h outcome). The data instead supports the opposite -- "reversal":
// clusters behave like support/resistance, price tends to bounce off them --
// but only when confirmed in ALL THREE lookback windows (58.0% win rate,
// +0.015% net/trade after fees at 4h; the 2/3-confirmed tier showed no real
// edge, still net-negative after fees). That edge is thin -- about 1/40th
// the size of the proven fear_greed+taker_flow combo -- so this is not wired
// into evaluateSignal/PROVEN_COMBOS; treat it as confluence context, not a
// standalone tradeable signal.
export const PROXIMITY_PCT = 0.015
const MIN_WINDOWS_FOR_SCORE = 3

export function scoreLiquidationClusters(currentPrice, confirmedClusters) {
  const rule = 'liquidation_cluster'
  const strong = confirmedClusters.filter((c) => c.windowsConfirmedIn >= MIN_WINDOWS_FOR_SCORE)
  if (strong.length === 0) {
    return { rule, score: 0, reason: null }
  }

  const above = strong.filter((c) => c.price > currentPrice).sort((a, b) => a.price - b.price)[0]
  const below = strong.filter((c) => c.price < currentPrice).sort((a, b) => b.price - a.price)[0]

  const aboveDistPct = above ? (above.price - currentPrice) / currentPrice : Infinity
  const belowDistPct = below ? (currentPrice - below.price) / currentPrice : Infinity

  // Reversal: price approaching a strongly-confirmed cluster ABOVE (short
  // liqs, resistance-like) tends to get rejected back down.
  if (aboveDistPct <= PROXIMITY_PCT && aboveDistPct <= belowDistPct) {
    return {
      rule,
      score: -1,
      reason: `price within ${(aboveDistPct * 100).toFixed(2)}% of a liquidation cluster at $${above.price.toFixed(0)} confirmed in all ${above.windowsConfirmedIn} windows (mostly short liqs -- acts as resistance, weak edge)`,
    }
  }

  // Reversal: price approaching a strongly-confirmed cluster BELOW (long
  // liqs, support-like) tends to bounce back up.
  if (belowDistPct <= PROXIMITY_PCT) {
    return {
      rule,
      score: 1,
      reason: `price within ${(belowDistPct * 100).toFixed(2)}% of a liquidation cluster at $${below.price.toFixed(0)} confirmed in all ${below.windowsConfirmedIn} windows (mostly long liqs -- acts as support, weak edge)`,
    }
  }

  return { rule, score: 0, reason: null }
}
