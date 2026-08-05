import './SignalHistory.scss'
import { formatDateTime } from '../lib/format'

const SIGNAL_META = {
  bullish: { label: 'Bullish', className: 'good' },
  bearish: { label: 'Bearish', className: 'critical' },
  neutral: { label: 'Neutral', className: 'neutral' },
}

export function SignalHistory({ history }) {
  if (history.length === 0) {
    return <p className="signal-history__empty">No signal history yet.</p>
  }

  return (
    <table className="signal-history">
      <thead>
        <tr>
          <th>Time</th>
          <th>Signal</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        {history.map((row) => {
          const meta = SIGNAL_META[row.signal] ?? SIGNAL_META.neutral
          return (
            <tr key={row.id}>
              <td className="tabular-nums">{formatDateTime(row.evaluated_at)}</td>
              <td>
                <span className={`signal-history__badge signal-history__badge--${meta.className}`}>
                  {meta.label}
                </span>
              </td>
              <td className="signal-history__reason">{row.reason}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
