import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import './LoginGate.scss'

// Gates its children behind a Supabase Auth session. Only used on the trade
// action page -- the read-only dashboard stays public. Supabase persists the
// session in localStorage, so once you log in on your phone once, this
// screen won't show up again on that device.
export function LoginGate({ children }) {
  const [session, setSession] = useState(undefined) // undefined = still checking
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  if (session === undefined) {
    return <p className="login-gate__status">Checking session…</p>
  }

  if (!session) {
    async function handleSubmit(e) {
      e.preventDefault()
      setSubmitting(true)
      setError(null)
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
      if (signInError) setError(signInError.message)
      setSubmitting(false)
    }

    return (
      <div className="login-gate">
        <form className="login-gate__form" onSubmit={handleSubmit}>
          <h2>Sign in</h2>
          <p className="login-gate__hint">This action is only for the account owner.</p>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          {error && <p className="login-gate__error">{error}</p>}
          <button type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    )
  }

  return children(session)
}
