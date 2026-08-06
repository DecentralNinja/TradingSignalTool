export const WINDOW_HOURS = 4
export const SHORT_WINDOW_HOURS = 1

// Extreme, one-sided funding hints at a crowded trade and reversal risk (contrarian).
function scoreFundingRate(rate) {
  const rule = 'funding_rate'
  if (rate > 0.0005) {
    return { rule, score: -1, reason: `funding rate ${(rate * 100).toFixed(4)}% is extremely positive (crowded longs, reversal risk)` }
  }
  if (rate < -0.0005) {
    return { rule, score: 1, reason: `funding rate ${(rate * 100).toFixed(4)}% is extremely negative (crowded shorts, reversal risk)` }
  }
  return { rule, score: 0, reason: null }
}

// Extreme retail long/short skew is also treated as contrarian. Weighted at
// half a normal rule's contribution: a 30-day backtest showed this rule's
// bearish calls wrong 68% of the time when paired with taker_flow (see
// backtest.js), so it now needs another rule to agree before it can push the
// score to bullish/bearish on its own.
function scoreLongShortRatio(ratio) {
  const rule = 'long_short_ratio'
  if (ratio > 2) {
    return { rule, score: -0.5, reason: `long/short ratio ${ratio.toFixed(2)} shows extreme long skew (contrarian bearish)` }
  }
  if (ratio < 0.5) {
    return { rule, score: 0.5, reason: `long/short ratio ${ratio.toFixed(2)} shows extreme short skew (contrarian bullish)` }
  }
  return { rule, score: 0, reason: null }
}

// Taker buy/sell volume is a real-time proxy for aggressive buying vs selling pressure.
function scoreTakerFlow(ratio) {
  const rule = 'taker_flow'
  if (ratio > 1.1) {
    return { rule, score: 1, reason: `taker buy/sell ratio ${ratio.toFixed(2)} shows aggressive buying pressure` }
  }
  if (ratio < 0.9) {
    return { rule, score: -1, reason: `taker buy/sell ratio ${ratio.toFixed(2)} shows aggressive selling pressure` }
  }
  return { rule, score: 0, reason: null }
}

// Unlike retail long/short ratio, top trader positioning is read as confirmation,
// not contrarian: extreme positioning by Binance's largest accounts is treated
// as "smart money" conviction rather than a crowded trade to fade.
function scoreTopTraderRatio(ratio) {
  const rule = 'top_trader_ratio'
  if (ratio == null) return { rule, score: 0, reason: null }
  if (ratio > 2) {
    return { rule, score: 1, reason: `top trader long/short ratio ${ratio.toFixed(2)} shows heavy long conviction (smart money bullish)` }
  }
  if (ratio < 0.5) {
    return { rule, score: -1, reason: `top trader long/short ratio ${ratio.toFixed(2)} shows heavy short conviction (smart money bearish)` }
  }
  return { rule, score: 0, reason: null }
}

// A positive basis (futures pricier than spot) reflects leveraged demand paying a
// premium (bullish); a negative basis reflects hedging/bearish pressure.
function scoreBasis(basisRate) {
  const rule = 'basis'
  if (basisRate == null) return { rule, score: 0, reason: null }
  if (basisRate > 0.001) {
    return { rule, score: 1, reason: `basis rate ${(basisRate * 100).toFixed(3)}% shows futures trading at a premium (leveraged demand)` }
  }
  if (basisRate < -0.001) {
    return { rule, score: -1, reason: `basis rate ${(basisRate * 100).toFixed(3)}% shows futures trading at a discount (hedging/bearish pressure)` }
  }
  return { rule, score: 0, reason: null }
}

// Only reinforces the funding-rate rule when Bybit independently shows the same
// extreme — confirms a market-wide crowded trade rather than Binance-specific
// noise. Deliberately does nothing when only one exchange is extreme, since that
// divergence is exactly the "don't trust this reading as much" case, not a
// separate signal to score on its own.
function scoreCrossExchangeFunding(binanceRate, bybitRate) {
  const rule = 'cross_exchange_funding'
  if (binanceRate == null || bybitRate == null) return { rule, score: 0, reason: null }

  const threshold = 0.0005
  const side = (rate) => (rate > threshold ? 1 : rate < -threshold ? -1 : 0)
  const binanceSide = side(binanceRate)
  const bybitSide = side(bybitRate)

  if (binanceSide !== 0 && binanceSide === bybitSide) {
    return {
      rule,
      score: -binanceSide,
      reason: `Binance and Bybit funding both extreme in the same direction (${(binanceRate * 100).toFixed(4)}% / ${(bybitRate * 100).toFixed(4)}%) — market-wide, not exchange-specific`,
    }
  }
  return { rule, score: 0, reason: null }
}

// Extreme sentiment is contrarian, same logic as funding rate and long/short
// ratio: broad fear often marks a bottom, broad greed often marks a top.
// Thresholds match alternative.me's own "Extreme Fear"/"Extreme Greed" bands
// rather than a number we picked ourselves.
function scoreFearGreed(value) {
  const rule = 'fear_greed'
  if (value == null) return { rule, score: 0, reason: null }
  if (value < 25) {
    return { rule, score: 1, reason: `Fear & Greed Index ${value} is Extreme Fear (contrarian bullish)` }
  }
  if (value > 75) {
    return { rule, score: -1, reason: `Fear & Greed Index ${value} is Extreme Greed (contrarian bearish)` }
  }
  return { rule, score: 0, reason: null }
}

// These seven rules all read the latest snapshot's value directly rather than
// anything averaged over a window, so they're identical regardless of which
// timeframe's signal is being evaluated -- only the trend/momentum rules below
// actually depend on window length.
function latestValueRules(latest) {
  return [
    scoreFundingRate(latest.funding_rate),
    scoreLongShortRatio(latest.long_short_ratio),
    scoreTakerFlow(latest.taker_buy_sell_ratio),
    scoreTopTraderRatio(latest.top_trader_long_short_ratio),
    scoreBasis(latest.basis_rate),
    scoreCrossExchangeFunding(latest.funding_rate, latest.bybit_funding_rate),
    scoreFearGreed(latest.fear_greed_value),
  ]
}

// Rising OI with rising price is a fresh trend; falling OI with rising price is
// likely short covering (a weaker move), and vice versa. Thresholds sized for
// a 4-hour window's typical cumulative movement.
function scoreOpenInterestTrend(priceChangePct, oiChangePct) {
  const rule = 'oi_price_trend'
  const priceUp = priceChangePct > 0.5
  const priceDown = priceChangePct < -0.5
  const oiUp = oiChangePct > 2
  const oiDown = oiChangePct < -2

  if (priceUp && oiUp) {
    return { rule, score: 1, reason: `price up ${priceChangePct.toFixed(2)}% with OI up ${oiChangePct.toFixed(2)}% (fresh trend)` }
  }
  if (priceUp && oiDown) {
    return { rule, score: -1, reason: `price up ${priceChangePct.toFixed(2)}% but OI down ${oiChangePct.toFixed(2)}% (likely short covering, weak move)` }
  }
  if (priceDown && oiUp) {
    return { rule, score: -1, reason: `price down ${priceChangePct.toFixed(2)}% with OI up ${oiChangePct.toFixed(2)}% (fresh shorting)` }
  }
  if (priceDown && oiDown) {
    return { rule, score: 1, reason: `price down ${priceChangePct.toFixed(2)}% but OI down ${oiChangePct.toFixed(2)}% (likely long liquidation exhaustion)` }
  }
  return { rule, score: 0, reason: null }
}

// Short-term price momentum -- a new rule, since nothing else measures
// unaveraged short-window price movement. Thresholds are a starting guess
// scaled down from the 4h rule's, not yet backtested.
function scorePriceMomentum(priceChangePct) {
  const rule = 'price_momentum'
  if (priceChangePct > 0.25) {
    return { rule, score: 1, reason: `price up ${priceChangePct.toFixed(2)}% in the last hour (momentum)` }
  }
  if (priceChangePct < -0.25) {
    return { rule, score: -1, reason: `price down ${priceChangePct.toFixed(2)}% in the last hour (momentum)` }
  }
  return { rule, score: 0, reason: null }
}

// Short-term OI momentum -- same idea as the 4h OI-trend rule but standalone
// (not cross-referenced with price direction), with smaller thresholds sized
// for an hour instead of four.
function scoreOpenInterestMomentum(oiChangePct) {
  const rule = 'oi_momentum'
  if (oiChangePct > 1) {
    return { rule, score: 1, reason: `open interest up ${oiChangePct.toFixed(2)}% in the last hour` }
  }
  if (oiChangePct < -1) {
    return { rule, score: -1, reason: `open interest down ${oiChangePct.toFixed(2)}% in the last hour` }
  }
  return { rule, score: 0, reason: null }
}

function scoreToSignal(totalScore) {
  if (totalScore >= 2) return 'bullish'
  if (totalScore <= -2) return 'bearish'
  return 'neutral'
}

function summarize(rules, extra = {}) {
  const totalScore = rules.reduce((sum, r) => sum + r.score, 0)
  const reasons = rules.filter((r) => r.reason).map((r) => r.reason)

  return {
    signal: scoreToSignal(totalScore),
    score: totalScore,
    reason: reasons.length > 0 ? reasons.join('; ') : 'no rules triggered',
    rules,
    ...extra,
  }
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

function priceAndOiChange(snapshots) {
  const earliest = snapshots[0]
  const latest = snapshots[snapshots.length - 1]
  return {
    priceChangePct: ((latest.mark_price - earliest.mark_price) / earliest.mark_price) * 100,
    oiChangePct: ((latest.open_interest - earliest.open_interest) / earliest.open_interest) * 100,
  }
}

// The original structural signal: latest-value rules plus the OI-vs-price
// trend rule, evaluated over a 4-hour window.
export function evaluateSignal(snapshots) {
  const latest = snapshots[snapshots.length - 1]
  const { priceChangePct, oiChangePct } = priceAndOiChange(snapshots)

  const rules = [...latestValueRules(latest), scoreOpenInterestTrend(priceChangePct, oiChangePct)]

  return summarize(rules, { volatility: computeRealizedVolatility(snapshots) })
}

// The faster momentum signal: the same latest-value rules plus two rules that
// specifically measure short-window price/OI movement, evaluated over 1 hour.
export function evaluateShortTermSignal(snapshots) {
  const latest = snapshots[snapshots.length - 1]
  const { priceChangePct, oiChangePct } = priceAndOiChange(snapshots)

  const rules = [
    ...latestValueRules(latest),
    scorePriceMomentum(priceChangePct),
    scoreOpenInterestMomentum(oiChangePct),
  ]

  return summarize(rules)
}
