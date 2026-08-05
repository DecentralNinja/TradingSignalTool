// Retries any thrown error with a short backoff — covers dropped connections
// and brief network blips. Retries permanent API errors too (won't help, but
// costs only a couple seconds before still failing correctly).
export async function withRetry(fn, { attempts = 3, delayMs = 1000 } = {}) {
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt))
      }
    }
  }

  throw lastError
}
