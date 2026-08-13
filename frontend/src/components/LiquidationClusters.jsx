import './LiquidationClusters.scss'
import { formatPrice, formatPercent } from '../lib/format'

export function LiquidationClusters({ clusters, currentPrice }) {
  if (!clusters || clusters.length === 0) {
    return <p className="liq-clusters__empty">No confirmed clusters yet — building history.</p>
  }

  const sorted = [...clusters].sort((a, b) => b.cluster_price - a.cluster_price)

  return (
    <div className="liq-clusters">
      <p className="liq-clusters__note">
        Estimated from open interest + assumed leverage, not real liquidation events. Backtesting found
        clusters confirmed in all 3 windows tend to act as weak support/resistance (price bounced rather
        than broke through ~58% of the time on a 4h horizon) — the edge is thin, so treat this as
        confluence context, not a standalone signal.
      </p>
      <table className="liq-clusters__table">
        <thead>
          <tr>
            <th>Price</th>
            <th>Likely acts as</th>
            <th>Distance</th>
            <th>Confirmation</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => {
            const distancePct = currentPrice ? ((c.cluster_price - currentPrice) / currentPrice) * 100 : null
            const isStrong = c.windows_confirmed_in >= 3
            return (
              <tr key={c.id} className={c.cluster_price > currentPrice ? 'liq-clusters__above' : 'liq-clusters__below'}>
                <td className="tabular-nums">{formatPrice(c.cluster_price)}</td>
                <td>
                  <span className="liq-clusters__badge">
                    {c.cluster_price > currentPrice ? 'Resistance' : 'Support'}
                  </span>
                </td>
                <td className="tabular-nums">
                  {distancePct != null ? formatPercent(distancePct, { signed: true, decimals: 2 }) : '—'}
                </td>
                <td className="tabular-nums">
                  {c.windows_confirmed_in}/3{isStrong ? ' (strong)' : ''}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
