import { createClient } from '@supabase/supabase-js'
import { withRetry } from './retry.js'

export function getSupabaseClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    return null
  }

  return createClient(url, key)
}

export async function saveSnapshot(client, snapshot) {
  await withRetry(async () => {
    const { error } = await client.from('market_snapshots').upsert(snapshot, {
      onConflict: 'symbol,fetched_at',
    })

    if (error) {
      throw new Error(`Failed to save snapshot: ${error.message}`)
    }
  })
}

export async function getRecentSnapshots(client, symbol, windowStart) {
  return withRetry(async () => {
    const { data, error } = await client
      .from('market_snapshots')
      .select('*')
      .eq('symbol', symbol)
      .gte('fetched_at', windowStart)
      .order('fetched_at', { ascending: true })

    if (error) {
      throw new Error(`Failed to load snapshots: ${error.message}`)
    }

    return data
  })
}

export async function saveSignal(client, signalRow) {
  await withRetry(async () => {
    const { error } = await client.from('signals').insert(signalRow)

    if (error) {
      throw new Error(`Failed to save signal: ${error.message}`)
    }
  })
}

export async function getRecentVolatilities(client, symbol, timeframe, limit) {
  return withRetry(async () => {
    const { data, error } = await client
      .from('signals')
      .select('volatility')
      .eq('symbol', symbol)
      .eq('timeframe', timeframe)
      .not('volatility', 'is', null)
      .order('evaluated_at', { ascending: false })
      .limit(limit)

    if (error) {
      throw new Error(`Failed to load volatility history: ${error.message}`)
    }

    return data.map((row) => row.volatility)
  })
}

// Signals old enough for their window to have played out, but not yet scored.
export async function getSignalsPendingOutcome(client, symbol, timeframe, cutoff) {
  return withRetry(async () => {
    const { data, error } = await client
      .from('signals')
      .select('id, evaluated_at, signal')
      .eq('symbol', symbol)
      .eq('timeframe', timeframe)
      .is('outcome_correct', null)
      .lte('evaluated_at', cutoff)
      .order('evaluated_at', { ascending: true })

    if (error) {
      throw new Error(`Failed to load pending signals: ${error.message}`)
    }

    return data
  })
}

// A signal's evaluated_at is always set to that cycle's snapshot fetched_at,
// so this is an exact lookup, not a nearest-match search.
export async function getSnapshotPrice(client, symbol, fetchedAt) {
  return withRetry(async () => {
    const { data, error } = await client
      .from('market_snapshots')
      .select('mark_price')
      .eq('symbol', symbol)
      .eq('fetched_at', fetchedAt)
      .maybeSingle()

    if (error) {
      throw new Error(`Failed to load snapshot price: ${error.message}`)
    }

    return data?.mark_price ?? null
  })
}

export async function saveSignalOutcome(client, signalId, outcome) {
  await withRetry(async () => {
    const { error } = await client.from('signals').update(outcome).eq('id', signalId)

    if (error) {
      throw new Error(`Failed to save signal outcome: ${error.message}`)
    }
  })
}
