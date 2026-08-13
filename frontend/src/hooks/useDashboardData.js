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

function signalsForTimeframe(timeframe, limit) {
  return supabase
    .from('signals')
    .select('*')
    .eq('symbol', SYMBOL)
    .eq('timeframe', timeframe)
    .order('evaluated_at', { ascending: false })
    .limit(limit)
}

function accuracyForTimeframe(timeframe) {
  return supabase
    .from('signals')
    .select('signal, outcome_correct')
    .eq('symbol', SYMBOL)
    .eq('timeframe', timeframe)
    .not('outcome_correct', 'is', null)
}

export function useDashboardData() {
  const [latestSnapshot, setLatestSnapshot] = useState(null)
  const [previousSnapshot, setPreviousSnapshot] = useState(null)
  const [latestSignal, setLatestSignal] = useState(null)
  const [signalHistory, setSignalHistory] = useState([])
  const [accuracy, setAccuracy] = useState(null)
  const [latestShortTermSignal, setLatestShortTermSignal] = useState(null)
  const [shortTermSignalHistory, setShortTermSignalHistory] = useState([])
  const [shortTermAccuracy, setShortTermAccuracy] = useState(null)
  const [liquidationClusters, setLiquidationClusters] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchData = useCallback(async () => {
    try {
      const [
        snapshotsResult,
        signalHistoryResult,
        accuracyResult,
        shortTermHistoryResult,
        shortTermAccuracyResult,
        liquidationClustersResult,
      ] = await Promise.all([
        supabase
          .from('market_snapshots')
          .select('*')
          .eq('symbol', SYMBOL)
          .order('fetched_at', { ascending: false })
          .limit(2),
        signalsForTimeframe('4h', HISTORY_LIMIT),
        accuracyForTimeframe('4h'),
        signalsForTimeframe('1h', HISTORY_LIMIT),
        accuracyForTimeframe('1h'),
        supabase
          .from('liquidation_clusters')
          .select('*')
          .eq('symbol', SYMBOL)
          .order('computed_at', { ascending: false })
          .order('cluster_price', { ascending: true })
          .limit(30),
      ])

      if (snapshotsResult.error) throw snapshotsResult.error
      if (signalHistoryResult.error) throw signalHistoryResult.error
      if (accuracyResult.error) throw accuracyResult.error
      if (shortTermHistoryResult.error) throw shortTermHistoryResult.error
      if (shortTermAccuracyResult.error) throw shortTermAccuracyResult.error
      if (liquidationClustersResult.error) throw liquidationClustersResult.error

      const [latest, previous] = snapshotsResult.data ?? []
      const history = signalHistoryResult.data ?? []
      const shortTermHistory = shortTermHistoryResult.data ?? []
      const allClusterRows = liquidationClustersResult.data ?? []
      const latestComputedAt = allClusterRows[0]?.computed_at
      const latestClusters = allClusterRows.filter((row) => row.computed_at === latestComputedAt)

      setLatestSnapshot(latest ?? null)
      setPreviousSnapshot(previous ?? null)
      setLatestSignal(history[0] ?? null)
      setSignalHistory(history)
      setAccuracy(computeAccuracy(accuracyResult.data ?? []))
      setLatestShortTermSignal(shortTermHistory[0] ?? null)
      setShortTermSignalHistory(shortTermHistory)
      setShortTermAccuracy(computeAccuracy(shortTermAccuracyResult.data ?? []))
      setLiquidationClusters(latestClusters)
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

  return {
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
  }
}
