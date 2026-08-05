import './SignalBanner.scss'
import { formatDateTime, formatPercent } from '../lib/format'

const SIGNAL_META = {
  bullish: { label: 'Bullish', className: 'good', icon: '▲' },
  bearish: { label: 'Bearish', className: 'critical', icon: '▼' },
  neutral: { label: 'Neutral', className: 'neutral', icon: '—' },
}

const REGIME_LABELS = {
  elevated: 'Elevated volatility',
  normal: 'Normal volatility',
  low: 'Low volatility',
  insufficient_history: 'Volatility: building history',
}

function volatilityText(signal) {
  const label = REGIME_LABELS[signal.volatility_regime]
  if (!label) return null
  if (signal.volatility_regime === 'insufficient_history') return label
  return `${label} (${formatPercent(signal.volatility, { decimals: 3 })})`
}

export function SignalBanner({ signal }) {
  if (!signal) {
    return (
      <div className="signal-banner signal-banner--neutral">
        <span className="signal-banner__icon">—</span>
        <div>
          <div className="signal-banner__label">No signal yet</div>
          <p className="signal-banner__reason">Waiting for enough data to evaluate.</p>
        </div>
      </div>
    )
  }

  const meta = SIGNAL_META[signal.signal] ?? SIGNAL_META.neutral

  return (
    <div className={`signal-banner signal-banner--${meta.className}`}>
      <span className="signal-banner__icon" aria-hidden="true">
        {meta.icon}
      </span>
      <div>
        <div className="signal-banner__label">{meta.label}</div>
        <p className="signal-banner__reason">{signal.reason}</p>
        <p className="signal-banner__timestamp">
          as of {formatDateTime(signal.evaluated_at)}
          {volatilityText(signal) && <> · {volatilityText(signal)}</>}
        </p>
      </div>
    </div>
  )
}
