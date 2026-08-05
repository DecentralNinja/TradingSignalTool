import './StatTile.scss'

export function StatTile({ label, value, delta }) {
  return (
    <div className="stat-tile">
      <div className="stat-tile__label">{label}</div>
      <div className="stat-tile__value">{value}</div>
      {delta != null && <div className="stat-tile__delta">{delta}</div>}
    </div>
  )
}
