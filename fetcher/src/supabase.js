import { createClient } from '@supabase/supabase-js'

export function getSupabaseClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    return null
  }

  return createClient(url, key)
}

export async function saveSnapshot(client, snapshot) {
  const { error } = await client.from('market_snapshots').upsert(snapshot, {
    onConflict: 'symbol,fetched_at',
  })

  if (error) {
    throw new Error(`Failed to save snapshot: ${error.message}`)
  }
}
