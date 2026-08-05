import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const SYMBOL = 'BTCUSDT'
const REFRESH_INTERVAL_MS = 30_000
const HISTORY_LIMIT = 20

export function useDashboardData() {
  const [latestSnapshot, setLatestSnapshot] = useState(null)
  const [previousSnapshot, setPreviousSnapshot] = useState(null)
  const [latestSignal, setLatestSignal] = useState(null)
  const [signalHistory, setSignalHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchData = useCallback(async () => {
    try {
      const [snapshotsResult, signalHistoryResult] = await Promise.all([
        supabase
          .from('market_snapshots')
          .select('*')
          .eq('symbol', SYMBOL)
          .order('fetched_at', { ascending: false })
          .limit(2),
        supabase
          .from('signals')
          .select('*')
          .eq('symbol', SYMBOL)
          .order('evaluated_at', { ascending: false })
          .limit(HISTORY_LIMIT),
      ])

      if (snapshotsResult.error) throw snapshotsResult.error
      if (signalHistoryResult.error) throw signalHistoryResult.error

      const [latest, previous] = snapshotsResult.data ?? []
      const history = signalHistoryResult.data ?? []

      setLatestSnapshot(latest ?? null)
      setPreviousSnapshot(previous ?? null)
      setLatestSignal(history[0] ?? null)
      setSignalHistory(history)
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [fetchData])

  return { latestSnapshot, previousSnapshot, latestSignal, signalHistory, loading, error }
}
