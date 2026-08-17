import './SignalBanner.scss'
import { formatDateTime, formatPercent, formatPrice } from '../lib/format'

// Reference leverage used only to frame the ROI% shown here -- matches the
// one used in the WhatsApp alert (fetcher/src/run.js), doesn't affect the
// price levels themselves.
const REFERENCE_LEVERAGE = 10

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
  // Only a backtest-proven combo gets the strong colored treatment -- an
  // "experimental" bullish/bearish call is a real rule-based read, but one
  // without evidence it makes money after fees, so it's styled neutral
  // rather than looking as actionable as a proven one.
  const isUnproven = signal.confidence === 'experimental'
  const className = isUnproven ? 'neutral' : meta.className

  return (
    <div className={`signal-banner signal-banner--${className}`}>
      <span className="signal-banner__icon" aria-hidden="true">
        {meta.icon}
      </span>
      <div>
        <div className="signal-banner__label">
          {meta.label}
          {signal.confidence === 'proven' && (
            <span className="signal-banner__confidence signal-banner__confidence--proven">Proven</span>
          )}
          {isUnproven && (
            <span className="signal-banner__confidence signal-banner__confidence--experimental">
              Not backtest-proven
            </span>
          )}
        </div>
        <p className="signal-banner__reason">{signal.reason}</p>
        {signal.take_profit_price != null && signal.stop_loss_price != null && (
          <div className="signal-banner__levels">
            <div className="signal-banner__level signal-banner__level--tp">
              <span className="signal-banner__level-label">TP</span>
              <span className="signal-banner__level-price">{formatPrice(signal.take_profit_price)}</span>
              <span className="signal-banner__level-roi">
                {formatPercent(signal.take_profit_pct * REFERENCE_LEVERAGE, { signed: true, decimals: 1 })} ROI @
                {REFERENCE_LEVERAGE}x
              </span>
            </div>
            <div className="signal-banner__level signal-banner__level--sl">
              <span className="signal-banner__level-label">SL</span>
              <span className="signal-banner__level-price">{formatPrice(signal.stop_loss_price)}</span>
              <span className="signal-banner__level-roi">
                {formatPercent(signal.stop_loss_pct * REFERENCE_LEVERAGE, { signed: true, decimals: 1 })} ROI @
                {REFERENCE_LEVERAGE}x
              </span>
            </div>
            {signal.exit_by_hours != null && (
              <span className="signal-banner__levels-exit">Exit by {signal.exit_by_hours}h if neither hit</span>
            )}
          </div>
        )}
        <p className="signal-banner__timestamp">
          as of {formatDateTime(signal.evaluated_at)}
          {volatilityText(signal) && <> · {volatilityText(signal)}</>}
        </p>
      </div>
    </div>
  )
}
