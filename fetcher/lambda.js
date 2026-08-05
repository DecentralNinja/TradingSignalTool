import { config } from 'dotenv'
config({ quiet: true })
import { getSupabaseClient } from './src/supabase.js'
import { runFetchCycle } from './src/run.js'

// Function URLs are invoked over plain HTTP with no built-in caller
// verification available to a third-party cron service, so a shared secret
// in the query string is the gate against randoms hitting a discoverable URL.
export const handler = async (event) => {
  const providedKey = event.queryStringParameters?.key
  if (providedKey !== process.env.INVOKE_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' }
  }

  const client = getSupabaseClient()
  if (!client) {
    return { statusCode: 500, body: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' }
  }

  const result = await runFetchCycle(client)
  console.log(JSON.stringify(result))

  return {
    statusCode: 200,
    body: JSON.stringify({ signal: result.signal.signal, evaluated_at: result.signal.evaluated_at }),
  }
}
