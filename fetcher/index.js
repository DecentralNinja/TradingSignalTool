import { config } from 'dotenv'
config({ quiet: true })
import { getSupabaseClient } from './src/supabase.js'
import { runFetchCycle } from './src/run.js'

async function main() {
  const client = getSupabaseClient()
  if (!client) {
    console.warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping DB write.')
    return
  }

  const { snapshot, signal, scoredOutcomes } = await runFetchCycle(client)
  console.log(snapshot)
  console.log('Saved to Supabase.')
  console.log('Signal:', signal)
  for (const outcome of scoredOutcomes) {
    console.log(
      `Scored signal ${outcome.id} (${outcome.signal}): ${outcome.correct ? 'correct' : 'incorrect'} (${outcome.priceChangePct.toFixed(2)}% move)`
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
