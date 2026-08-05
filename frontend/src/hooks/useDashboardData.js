import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const SYMBOL = 'BTCUSDT'
const REFRESH_INTERVAL_MS = 30_000
const HISTORY_LIMIT = 20

function computeAccuracy(scoredSignals) {
  const byType = { bullish: { correct: 0, total: 0 }, bearish: { correct: 0, total: 0 }, neutral: { correct: 0, total: 0 } }

  for (const row of scoredSignals) {
    const bucket = byType[row.signal]
    if (!bucket) continue
    bucket.total += 1
    if (row.outcome_correct) bucket.correct += 1
  }

  return byType
}

export function useDashboardData() {
  const [latestSnapshot, setLatestSnapshot] = useState(null)
  const [previousSnapshot, setPreviousSnapshot] = useState(null)
  const [latestSignal, setLatestSignal] = useState(null)
  const [signalHistory, setSignalHistory] = useState([])
  const [accuracy, setAccuracy] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchData = useCallback(async () => {
    try {
      const [snapshotsResult, signalHistoryResult, accuracyResult] = await Promise.all([
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
        supabase
          .from('signals')
          .select('signal, outcome_correct')
          .eq('symbol', SYMBOL)
          .not('outcome_correct', 'is', null),
      ])

      if (snapshotsResult.error) throw snapshotsResult.error
      if (signalHistoryResult.error) throw signalHistoryResult.error
      if (accuracyResult.error) throw accuracyResult.error

      const [latest, previous] = snapshotsResult.data ?? []
      const history = signalHistoryResult.data ?? []

      setLatestSnapshot(latest ?? null)
      setPreviousSnapshot(previous ?? null)
      setLatestSignal(history[0] ?? null)
      setSignalHistory(history)
      setAccuracy(computeAccuracy(accuracyResult.data ?? []))
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

  return { latestSnapshot, previousSnapshot, latestSignal, signalHistory, accuracy, loading, error }
}
