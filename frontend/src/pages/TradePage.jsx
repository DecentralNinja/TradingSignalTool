import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { LoginGate } from '../components/LoginGate'
import { formatPrice, formatPercent, formatDateTime } from '../lib/format'
import './TradePage.scss'

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL

function getSignalIdFromUrl() {
  const params = new URLSearchParams(window.location.search)
  return params.get('signal')
}

async function callBridge(path, session, body) {
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Request failed')
  return data
}

function TradeContent({ session }) {
  const signalId = getSignalIdFromUrl()
  const [signal, setSignal] = useState(null)
  const [trade, setTrade] = useState(null)
  const [livePrice, setLivePrice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    if (!signalId) return
    const { data: signalRow } = await supabase.from('signals').select('*').eq('id', signalId).single()
    setSignal(signalRow)

    const { data: tradeRows } = await supabase
      .from('trades')
      .select('*')
      .eq('signal_id', signalId)
      .order('created_at', { ascending: false })
      .limit(1)
    setTrade(tradeRows?.[0] || null)

    const { data: snapshot } = await supabase
      .from('market_snapshots')
      .select('mark_price')
      .order('fetched_at', { ascending: false })
      .limit(1)
      .single()
    setLivePrice(snapshot?.mark_price ?? null)
  }, [signalId])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 15000)
    return () => clearInterval(interval)
  }, [refresh])

  if (!signalId) return <p className="trade-page__status">No signal specified.</p>
  if (!signal) return <p className="trade-page__status">Loading signal…</p>

  async function handleOpen() {
    setBusy(true)
    setError(null)
    try {
      await callBridge('/trade/open', session, { signalId: signal.id })
      await refresh()
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  async function handleClose() {
    setBusy(true)
    setError(null)
    try {
      await callBridge('/trade/close', session, { tradeId: trade.id })
      await refresh()
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  const direction = signal.signal === 'bullish' ? 'Long' : signal.signal === 'bearish' ? 'Short' : 'Neutral'
  const livePnlPct =
    trade?.status === 'open' && livePrice != null
      ? ((livePrice - trade.entry_price) / trade.entry_price) * 100 * (trade.direction === 'long' ? 1 : -1)
      : null

  return (
    <div className="trade-page">
      <h1>
        {signal.timeframe} {direction} signal
      </h1>
      <p className="trade-page__meta">{formatDateTime(signal.evaluated_at)} · {signal.combo}</p>

      <div className="trade-page__levels">
        <div>
          <span>Take profit</span>
          <strong>{formatPrice(signal.take_profit_price)}</strong>
        </div>
        <div>
          <span>Stop loss</span>
          <strong>{formatPrice(signal.stop_loss_price)}</strong>
        </div>
        <div>
          <span>Size</span>
          <strong>
            {signal.position_size_label} ({signal.position_size_pct}%)
          </strong>
        </div>
      </div>

      {error && <p className="trade-page__error">{error}</p>}

      {!trade || trade.status === 'failed' ? (
        <button className="trade-page__btn trade-page__btn--open" onClick={handleOpen} disabled={busy}>
          {busy ? 'Opening…' : 'Take Trade'}
        </button>
      ) : trade.status === 'open' ? (
        <div className="trade-page__open">
          <p className="trade-page__live-pnl">
            Entry {formatPrice(trade.entry_price)} · Now {formatPrice(livePrice)} ·{' '}
            <span className={livePnlPct >= 0 ? 'trade-page__pnl--up' : 'trade-page__pnl--down'}>
              {formatPercent(livePnlPct, { signed: true })}
            </span>
          </p>
          <button className="trade-page__btn trade-page__btn--close" onClick={handleClose} disabled={busy}>
            {busy ? 'Closing…' : 'Close Trade'}
          </button>
        </div>
      ) : (
        <p className="trade-page__done">
          Trade {trade.status.replace('closed_', '')} · exit {formatPrice(trade.exit_price)} ·{' '}
          {formatPercent(trade.pnl_pct, { signed: true })}
        </p>
      )}

      {trade?.is_demo && <p className="trade-page__demo-tag">Demo trading — no real funds</p>}
    </div>
  )
}

export function TradePage() {
  return <LoginGate>{(session) => <TradeContent session={session} />}</LoginGate>
}
