import './App.scss'
import { useDashboardData } from './hooks/useDashboardData'
import { SignalBanner } from './components/SignalBanner'
import { StatTile } from './components/StatTile'
import { SignalHistory } from './components/SignalHistory'
import { AccuracyStats } from './components/AccuracyStats'
import { LiquidationClusters } from './components/LiquidationClusters'
import { formatDateTime, formatPercent, formatPrice, formatRatio } from './lib/format'

function percentChange(current, previous) {
  if (current == null || previous == null || previous === 0) return null
  return ((current - previous) / previous) * 100
}

function App() {
  const {
    latestSnapshot,
    previousSnapshot,
    latestSignal,
    signalHistory,
    accuracy,
    latestShortTermSignal,
    shortTermSignalHistory,
    shortTermAccuracy,
    liquidationClusters,
    loading,
    error,
  } = useDashboardData()

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
        <div className="app__header-inner">
          <div>
            <h1>Crypto Signal Tool</h1>
            <p className="app__symbol">BTC/USDT</p>
          </div>
          <div className="app__hero">
            <div className="app__price">{formatPrice(latestSnapshot?.mark_price)}</div>
            <div className="app__hero-meta">
              {priceDelta != null && (
                <span
                  className={`app__price-delta ${priceDelta >= 0 ? 'app__price-delta--up' : 'app__price-delta--down'}`}
                >
                  {formatPercent(priceDelta, { signed: true })}
                </span>
              )}
              {latestSnapshot && (
                <span className="app__updated">updated {formatDateTime(latestSnapshot.fetched_at)}</span>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="app__body">
        <section className="app__pair">
          <div className="app__pane">
            <h2>4-Hour Signal</h2>
            <SignalBanner signal={latestSignal} />
          </div>
          <div className="app__pane">
            <h2>1-Hour Signal</h2>
            <SignalBanner signal={latestShortTermSignal} />
          </div>
        </section>

        <section className="app__section">
          <h2>Market Metrics</h2>
          <div className="app__metrics">
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
            <StatTile
              label="Bybit funding rate"
              value={formatPercent((latestSnapshot?.bybit_funding_rate ?? 0) * 100, { decimals: 4 })}
            />
            <StatTile
              label="Binance vs Bybit price"
              value={priceDivergence != null ? formatPercent(priceDivergence, { signed: true, decimals: 3 }) : '—'}
            />
            <StatTile
              label="Fear & Greed Index"
              value={latestSnapshot?.fear_greed_value != null ? `${latestSnapshot.fear_greed_value}` : '—'}
              delta={latestSnapshot?.fear_greed_classification ?? null}
            />
            <StatTile
              label="CFTC leveraged funds L/S"
              value={formatRatio(latestSnapshot?.cftc_lev_funds_long_short_ratio)}
              delta={
                latestSnapshot?.cftc_report_date
                  ? `as of ${formatDateTime(latestSnapshot.cftc_report_date)}`
                  : null
              }
            />
          </div>
        </section>

        <section className="app__pair">
          <div className="app__card">
            <h2>4-Hour Signal Accuracy</h2>
            <AccuracyStats accuracy={accuracy} />
          </div>
          <div className="app__card">
            <h2>1-Hour Signal Accuracy</h2>
            <AccuracyStats accuracy={shortTermAccuracy} />
          </div>
        </section>

        <section className="app__section">
          <div className="app__card">
            <h2>Estimated Liquidation Clusters</h2>
            <LiquidationClusters clusters={liquidationClusters} currentPrice={latestSnapshot?.mark_price} />
          </div>
        </section>

        <section className="app__pair app__pair--history">
          <div className="app__card">
            <h2>4-Hour Signal History</h2>
            <SignalHistory history={signalHistory} />
          </div>
          <div className="app__card">
            <h2>1-Hour Signal History</h2>
            <SignalHistory history={shortTermSignalHistory} />
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
