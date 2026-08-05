import './AccuracyStats.scss'

const LABELS = {
  bullish: 'Bullish',
  bearish: 'Bearish',
  neutral: 'Neutral',
}

export function AccuracyStats({ accuracy }) {
  if (!accuracy) return null

  const rows = Object.entries(accuracy).filter(([, { total }]) => total > 0)

  if (rows.length === 0) {
    return <p className="accuracy-stats__empty">No scored signals yet — each one needs 4 hours to play out first.</p>
  }

  return (
    <div className="accuracy-stats">
      {rows.map(([type, { correct, total }]) => {
        const pct = Math.round((correct / total) * 100)
        return (
          <div key={type} className="accuracy-stats__row">
            <span className="accuracy-stats__label">{LABELS[type]}</span>
            <span className="accuracy-stats__value">
              {correct}/{total} correct ({pct}%)
            </span>
          </div>
        )
      })}
    </div>
  )
}
