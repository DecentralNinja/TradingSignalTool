// Same threshold the OI-trend rule uses elsewhere, reused here for consistency
// rather than picking a new number: a move smaller than this counts as "flat".
const FLAT_THRESHOLD_PCT = 0.5

// Bullish/bearish predict a direction; neutral predicts the opposite -- that
// price stays calm. So neutral is scored on magnitude, not direction: correct
// if the move stayed small, incorrect if it moved a lot either way.
export function evaluateOutcome(signalDirection, originalPrice, currentPrice) {
  const priceChangePct = ((currentPrice - originalPrice) / originalPrice) * 100

  let correct
  if (signalDirection === 'bullish') {
    correct = priceChangePct > 0
  } else if (signalDirection === 'bearish') {
    correct = priceChangePct < 0
  } else {
    correct = Math.abs(priceChangePct) < FLAT_THRESHOLD_PCT
  }

  return { correct, priceChangePct }
}
