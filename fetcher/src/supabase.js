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

export async function getRecentVolatilities(client, symbol, limit) {
  return withRetry(async () => {
    const { data, error } = await client
      .from('signals')
      .select('volatility')
      .eq('symbol', symbol)
      .not('volatility', 'is', null)
      .order('evaluated_at', { ascending: false })
      .limit(limit)

    if (error) {
      throw new Error(`Failed to load volatility history: ${error.message}`)
    }

    return data.map((row) => row.volatility)
  })
}
