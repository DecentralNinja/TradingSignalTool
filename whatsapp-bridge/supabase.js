// Talks to Supabase two ways: service-role writes to the trades table
// (bypasses RLS, same pattern as the fetcher), and verifying a logged-in
// owner's access token against Supabase Auth before letting a request
// through to the trade-execution endpoints.
const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

async function verifyUser(accessToken) {
  if (!accessToken) return null
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  })
  if (!res.ok) return null
  return res.json()
}

async function insertTrade(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/trades`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Supabase insert failed: ${JSON.stringify(data)}`)
  return data[0]
}

async function updateTrade(id, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/trades?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Supabase update failed: ${JSON.stringify(data)}`)
  return data[0]
}

async function getTrade(id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/trades?id=eq.${id}&select=*`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  })
  const data = await res.json()
  return data[0] || null
}

async function getLatestSnapshot() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/market_snapshots?select=mark_price,fetched_at&order=fetched_at.desc&limit=1`,
    { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } }
  )
  const data = await res.json()
  return data[0] || null
}

async function getSignal(id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/signals?id=eq.${id}&select=*`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  })
  const data = await res.json()
  return data[0] || null
}

module.exports = { verifyUser, insertTrade, updateTrade, getTrade, getSignal, getLatestSnapshot }
