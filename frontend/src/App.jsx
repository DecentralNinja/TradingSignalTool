import './App.scss'
import { useDashboardData } from './hooks/useDashboardData'
import { SignalBanner } from './components/SignalBanner'
import { StatTile } from './components/StatTile'
import { SignalHistory } from './components/SignalHistory'
import { formatDateTime, formatPercent, formatPrice, formatRatio } from './lib/format'

function percentChange(current, previous) {
  if (current == null || previous == null || previous === 0) return null
  return ((current - previous) / previous) * 100
}

function App() {
  const { latestSnapshot, previousSnapshot, latestSignal, signalHistory, loading, error } =
    useDashboardData()

  if (loading) {
    return (
      <div className="app">
        <p className="app__status">Loading…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="app">
        <p className="app__status app__status--error">Couldn't load data: {error}</p>
      </div>
    )
  }

  const priceDelta = percentChange(latestSnapshot?.mark_price, previousSnapshot?.mark_price)
  const oiDelta = percentChange(latestSnapshot?.open_interest, previousSnapshot?.open_interest)
  const priceDivergence = percentChange(latestSnapshot?.mark_price, latestSnapshot?.bybit_mark_price)

  return (
    <div className="app">
      <header className="app__header">
        <h1>Crypto Signal Tool</h1>
        <p className="app__symbol">BTC/USDT</p>
      </header>

      <section className="app__hero">
        <div className="app__price">{formatPrice(latestSnapshot?.mark_price)}</div>
        {priceDelta != null && (
          <div className="app__price-delta">{formatPercent(priceDelta, { signed: true })}</div>
        )}
        {latestSnapshot && (
          <p className="app__updated">updated {formatDateTime(latestSnapshot.fetched_at)}</p>
        )}
      </section>

      <section className="app__section">
        <SignalBanner signal={latestSignal} />
      </section>

      <section className="app__section app__metrics">
        <StatTile
          label="Funding rate"
          value={formatPercent((latestSnapshot?.funding_rate ?? 0) * 100, { decimals: 4 })}
        />
        <StatTile
          label="Open interest"
          value={latestSnapshot ? latestSnapshot.open_interest.toLocaleString('en-US') : '—'}
          delta={oiDelta != null ? formatPercent(oiDelta, { signed: true }) : null}
        />
        <StatTile label="Long/short ratio" value={formatRatio(latestSnapshot?.long_short_ratio)} />
        <StatTile
          label="Taker buy/sell ratio"
          value={formatRatio(latestSnapshot?.taker_buy_sell_ratio)}
        />
      </section>

      <section className="app__section app__metrics">
        <StatTile
          label="Bybit funding rate"
          value={formatPercent((latestSnapshot?.bybit_funding_rate ?? 0) * 100, { decimals: 4 })}
        />
        <StatTile
          label="Binance vs Bybit price"
          value={priceDivergence != null ? formatPercent(priceDivergence, { signed: true, decimals: 3 }) : '—'}
        />
      </section>

      <section className="app__section">
        <h2>Signal history</h2>
        <SignalHistory history={signalHistory} />
      </section>
    </div>
  )
}

export default App
