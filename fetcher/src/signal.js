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
  }
}
