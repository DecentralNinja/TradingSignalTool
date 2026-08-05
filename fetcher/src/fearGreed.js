import { withRetry } from './retry.js'

const BASE = 'https://api.alternative.me/fng'

// Updates once a day; fetching every cycle just re-reads the same current value,
// which is fine — no rate limit or auth on this endpoint.
export async function getFearGreedIndex() {
  return withRetry(async () => {
    const res = await fetch(`${BASE}/?limit=1`)
    if (!res.ok) {
      throw new Error(`Fear & Greed Index fetch failed: ${res.status}`)
    }
    const body = await res.json()
    const [data] = body.data
    return {
      value: Number(data.value),
      classification: data.value_classification,
    }
  })
}
