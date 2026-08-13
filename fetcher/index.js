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

  const { snapshot, signal, scoredOutcomes, shortTermSignal, shortTermScoredOutcomes, liquidationClusters } =
    await runFetchCycle(client)
  console.log(snapshot)
  console.log('Saved to Supabase.')
  console.log('4h Signal:', signal)
  console.log('1h Signal:', shortTermSignal)
  for (const outcome of [...scoredOutcomes, ...shortTermScoredOutcomes]) {
    console.log(
      `Scored signal ${outcome.id} (${outcome.signal}): ${outcome.correct ? 'correct' : 'incorrect'} (${outcome.priceChangePct.toFixed(2)}% move)`
    )
  }
  console.log('Liquidation clusters:', liquidationClusters)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
