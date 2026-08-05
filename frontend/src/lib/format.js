export function formatPrice(value) {
  if (value == null) return '—'
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

export function formatPercent(value, { signed = false, decimals = 2 } = {}) {
  if (value == null) return '—'
  const sign = signed && value > 0 ? '+' : ''
  return `${sign}${value.toFixed(decimals)}%`
}

export function formatRatio(value) {
  if (value == null) return '—'
  return value.toFixed(2)
}

export function formatDateTime(isoString) {
  if (!isoString) return '—'
  return new Date(isoString).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
