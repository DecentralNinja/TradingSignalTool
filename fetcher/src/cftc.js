import { withRetry } from './retry.js'

const BASE = 'https://publicreporting.cftc.gov/resource/gpe5-46if.json'
// CME's standard Bitcoin futures contract (not Micro Bitcoin, not Coinbase's).
const BITCOIN_CONTRACT_CODE = '133741'

// Published weekly (Tuesday data, released Friday) -- this will report the
// same value for up to a week between COT releases, unlike everything else
// in the pipeline which refreshes every 15 minutes.
export async function getLeveragedFundsPositioning() {
  return withRetry(async () => {
    const url = new URL(BASE)
    url.searchParams.set('$where', `cftc_contract_market_code='${BITCOIN_CONTRACT_CODE}'`)
    url.searchParams.set('$order', 'report_date_as_yyyy_mm_dd DESC')
    url.searchParams.set('$limit', '1')
    url.searchParams.set(
      '$select',
      'report_date_as_yyyy_mm_dd,lev_money_positions_long,lev_money_positions_short'
    )

    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`CFTC COT fetch failed: ${res.status} ${await res.text()}`)
    }
    const data = await res.json()
    if (data.length === 0) {
      throw new Error('CFTC COT returned no data for the CME Bitcoin contract')
    }

    const [row] = data
    const long = Number(row.lev_money_positions_long)
    const short = Number(row.lev_money_positions_short)

    return {
      reportDate: row.report_date_as_yyyy_mm_dd,
      leveragedFundsLong: long,
      leveragedFundsShort: short,
      leveragedFundsLongShortRatio: short > 0 ? long / short : null,
    }
  })
}
