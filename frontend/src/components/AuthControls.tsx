import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useAuthSession } from '../auth/AuthSessionContext'

type AuthMode = 'login' | 'register'

export function AuthControls() {
  const { status, session, error: sessionError, login, register, logout, retry } = useAuthSession()
  const [mode, setMode] = useState<AuthMode | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (mode) emailRef.current?.focus()
  }, [mode])

  function openDialog(nextMode: AuthMode, trigger: HTMLButtonElement) {
    triggerRef.current = trigger
    setEmail('')
    setPassword('')
    setError(null)
    setMode(nextMode)
  }

  function closeDialog() {
    if (isSubmitting) return
    setMode(null)
    setEmail('')
    setPassword('')
    setError(null)
    triggerRef.current?.focus()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!mode) return
    setIsSubmitting(true)
    setError(null)
    try {
      await (mode === 'login' ? login(email, password) : register(email, password))
      setIsSubmitting(false)
      closeDialog()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Ocurrió un error inesperado')
      setIsSubmitting(false)
    }
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeDialog()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'input, button:not(:disabled)',
    ))
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  async function handleLogout() {
    setIsSubmitting(true)
    setError(null)
    try {
      await logout()
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : 'Ocurrió un error inesperado')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (status === 'loading') {
    return <div className="auth-controls" role="status">Preparando sesión…</div>
  }

  if (status === 'error') {
    return (
      <div className="auth-controls auth-controls--error">
        <span>{sessionError ?? 'La sesión no está disponible'}</span>
        <button type="button" onClick={retry}>Reintentar sesión</button>
      </div>
    )
  }

  if (session?.user) {
    return (
      <div className="auth-controls">
        <span title={session.user.email}>{session.user.email}</span>
        <button type="button" disabled={isSubmitting} onClick={() => void handleLogout()}>
          {isSubmitting ? 'Saliendo…' : 'Salir'}
        </button>
        {error && <span className="auth-controls__error" role="alert">{error}</span>}
      </div>
    )
  }

  return (
    <div className="auth-controls">
      <span>Invitado</span>
      <button type="button" onClick={(event) => openDialog('login', event.currentTarget)}>Entrar</button>
      <button type="button" onClick={(event) => openDialog('register', event.currentTarget)}>Crear cuenta</button>
      {mode && (
        <div className="dialog-backdrop">
          <div
            className="auth-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-dialog-title"
            onKeyDown={handleDialogKeyDown}
          >
            <h2 id="auth-dialog-title">{mode === 'login' ? 'Entrar' : 'Crear cuenta'}</h2>
            <form onSubmit={submit}>
              <label>
                Email
                <input ref={emailRef} type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
              </label>
              <label>
                Contraseña
                <input type="password" required minLength={12} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
              {error && <p className="message message--error" role="alert">{error}</p>}
              <div className="auth-dialog__actions">
                <button className="secondary-button" type="button" disabled={isSubmitting} onClick={closeDialog}>Cancelar</button>
                <button className="primary-button" type="submit" disabled={isSubmitting}>
                  {isSubmitting ? 'Procesando…' : mode === 'login' ? 'Entrar' : 'Crear cuenta'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
