export const WINDOW_HOURS = 4

// Extreme, one-sided funding hints at a crowded trade and reversal risk (contrarian).
function scoreFundingRate(rate) {
  if (rate > 0.0005) {
    return { score: -1, reason: `funding rate ${(rate * 100).toFixed(4)}% is extremely positive (crowded longs, reversal risk)` }
  }
  if (rate < -0.0005) {
    return { score: 1, reason: `funding rate ${(rate * 100).toFixed(4)}% is extremely negative (crowded shorts, reversal risk)` }
  }
  return { score: 0, reason: null }
}

// Extreme retail long/short skew is also treated as contrarian.
function scoreLongShortRatio(ratio) {
  if (ratio > 2) {
    return { score: -1, reason: `long/short ratio ${ratio.toFixed(2)} shows extreme long skew (contrarian bearish)` }
  }
  if (ratio < 0.5) {
    return { score: 1, reason: `long/short ratio ${ratio.toFixed(2)} shows extreme short skew (contrarian bullish)` }
  }
  return { score: 0, reason: null }
}

// Taker buy/sell volume is a real-time proxy for aggressive buying vs selling pressure.
function scoreTakerFlow(ratio) {
  if (ratio > 1.1) {
    return { score: 1, reason: `taker buy/sell ratio ${ratio.toFixed(2)} shows aggressive buying pressure` }
  }
  if (ratio < 0.9) {
    return { score: -1, reason: `taker buy/sell ratio ${ratio.toFixed(2)} shows aggressive selling pressure` }
  }
  return { score: 0, reason: null }
}

// Unlike retail long/short ratio, top trader positioning is read as confirmation,
// not contrarian: extreme positioning by Binance's largest accounts is treated
// as "smart money" conviction rather than a crowded trade to fade.
function scoreTopTraderRatio(ratio) {
  if (ratio == null) return { score: 0, reason: null }
  if (ratio > 2) {
    return { score: 1, reason: `top trader long/short ratio ${ratio.toFixed(2)} shows heavy long conviction (smart money bullish)` }
  }
  if (ratio < 0.5) {
    return { score: -1, reason: `top trader long/short ratio ${ratio.toFixed(2)} shows heavy short conviction (smart money bearish)` }
  }
  return { score: 0, reason: null }
}

// A positive basis (futures pricier than spot) reflects leveraged demand paying a
// premium (bullish); a negative basis reflects hedging/bearish pressure.
function scoreBasis(basisRate) {
  if (basisRate == null) return { score: 0, reason: null }
  if (basisRate > 0.001) {
    return { score: 1, reason: `basis rate ${(basisRate * 100).toFixed(3)}% shows futures trading at a premium (leveraged demand)` }
  }
  if (basisRate < -0.001) {
    return { score: -1, reason: `basis rate ${(basisRate * 100).toFixed(3)}% shows futures trading at a discount (hedging/bearish pressure)` }
  }
  return { score: 0, reason: null }
}

// Only reinforces the funding-rate rule when Bybit independently shows the same
// extreme — confirms a market-wide crowded trade rather than Binance-specific
// noise. Deliberately does nothing when only one exchange is extreme, since that
// divergence is exactly the "don't trust this reading as much" case, not a
// separate signal to score on its own.
function scoreCrossExchangeFunding(binanceRate, bybitRate) {
  if (binanceRate == null || bybitRate == null) return { score: 0, reason: null }

  const threshold = 0.0005
  const side = (rate) => (rate > threshold ? 1 : rate < -threshold ? -1 : 0)
  const binanceSide = side(binanceRate)
  const bybitSide = side(bybitRate)

  if (binanceSide !== 0 && binanceSide === bybitSide) {
    return {
      score: -binanceSide,
      reason: `Binance and Bybit funding both extreme in the same direction (${(binanceRate * 100).toFixed(4)}% / ${(bybitRate * 100).toFixed(4)}%) — market-wide, not exchange-specific`,
    }
  }
  return { score: 0, reason: null }
}

// Extreme sentiment is contrarian, same logic as funding rate and long/short
// ratio: broad fear often marks a bottom, broad greed often marks a top.
// Thresholds match alternative.me's own "Extreme Fear"/"Extreme Greed" bands
// rather than a number we picked ourselves.
function scoreFearGreed(value) {
  if (value == null) return { score: 0, reason: null }
  if (value < 25) {
    return { score: 1, reason: `Fear & Greed Index ${value} is Extreme Fear (contrarian bullish)` }
  }
  if (value > 75) {
    return { score: -1, reason: `Fear & Greed Index ${value} is Extreme Greed (contrarian bearish)` }
  }
  return { score: 0, reason: null }
}

// Rising OI with rising price is a fresh trend; falling OI with rising price is
// likely short covering (a weaker move), and vice versa.
function scoreOpenInterestTrend(priceChangePct, oiChangePct) {
  const priceUp = priceChangePct > 0.5
  const priceDown = priceChangePct < -0.5
  const oiUp = oiChangePct > 2
  const oiDown = oiChangePct < -2

  if (priceUp && oiUp) {
    return { score: 1, reason: `price up ${priceChangePct.toFixed(2)}% with OI up ${oiChangePct.toFixed(2)}% (fresh trend)` }
  }
  if (priceUp && oiDown) {
    return { score: -1, reason: `price up ${priceChangePct.toFixed(2)}% but OI down ${oiChangePct.toFixed(2)}% (likely short covering, weak move)` }
  }
  if (priceDown && oiUp) {
    return { score: -1, reason: `price down ${priceChangePct.toFixed(2)}% with OI up ${oiChangePct.toFixed(2)}% (fresh shorting)` }
  }
  if (priceDown && oiDown) {
    return { score: 1, reason: `price down ${priceChangePct.toFixed(2)}% but OI down ${oiChangePct.toFixed(2)}% (likely long liquidation exhaustion)` }
  }
  return { score: 0, reason: null }
}

// Standard deviation of log returns between consecutive snapshots in the window —
// a measure of how choppy/volatile price action has been, in our own units (not
// annualized), so it's only meaningful compared against our own history below.
export function computeRealizedVolatility(snapshots) {
  if (snapshots.length < 2) return null

  const returns = []
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1].mark_price
    const curr = snapshots[i].mark_price
    returns.push(Math.log(curr / prev))
  }

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length
  return Math.sqrt(variance) * 100
}

// Classifies the current window's volatility relative to a trailing average of
// our own past readings — not an absolute threshold, since we have no validated
// basis for one yet. Needs a handful of prior readings before it means anything.
export function classifyVolatilityRegime(currentVolatility, recentVolatilities) {
  if (currentVolatility == null) return 'unknown'
  if (recentVolatilities.length < 5) return 'insufficient_history'

  const baseline = recentVolatilities.reduce((sum, v) => sum + v, 0) / recentVolatilities.length

  if (currentVolatility > baseline * 1.2) return 'elevated'
  if (currentVolatility < baseline * 0.8) return 'low'
  return 'normal'
}

// snapshots must be sorted ascending by fetched_at and cover the rolling window.
export function evaluateSignal(snapshots) {
  const earliest = snapshots[0]
  const latest = snapshots[snapshots.length - 1]

  const priceChangePct = ((latest.mark_price - earliest.mark_price) / earliest.mark_price) * 100
  const oiChangePct = ((latest.open_interest - earliest.open_interest) / earliest.open_interest) * 100

  const rules = [
    scoreFundingRate(latest.funding_rate),
    scoreLongShortRatio(latest.long_short_ratio),
    scoreTakerFlow(latest.taker_buy_sell_ratio),
    scoreOpenInterestTrend(priceChangePct, oiChangePct),
    scoreTopTraderRatio(latest.top_trader_long_short_ratio),
    scoreBasis(latest.basis_rate),
    scoreCrossExchangeFunding(latest.funding_rate, latest.bybit_funding_rate),
    scoreFearGreed(latest.fear_greed_value),
  ]

  const totalScore = rules.reduce((sum, r) => sum + r.score, 0)
  const reasons = rules.filter((r) => r.reason).map((r) => r.reason)

  let signal = 'neutral'
  if (totalScore >= 2) signal = 'bullish'
  else if (totalScore <= -2) signal = 'bearish'

  return {
    signal,
    score: totalScore,
    reason: reasons.length > 0 ? reasons.join('; ') : 'no rules triggered',
    volatility: computeRealizedVolatility(snapshots),
  }
}
