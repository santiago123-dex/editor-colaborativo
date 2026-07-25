import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  getSession,
  login as loginRequest,
  logout as logoutRequest,
  register as registerRequest,
  type AuthSession,
} from '../api/auth'
import { HttpError, setCsrfToken, subscribeToSessionChanges } from '../api/http'

const SESSION_CHANNEL_NAME = 'auth-session'
const SESSION_CHANGED_SIGNAL = 'session-changed'

export type AuthSessionStatus = 'loading' | 'ready' | 'error'

export interface AuthSessionContextValue {
  status: AuthSessionStatus
  session: AuthSession | null
  revision: number
  error: string | null
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  retry: () => void
}

export const AuthSessionContext = createContext<AuthSessionContextValue | null>(null)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Ocurrió un error inesperado'
}

export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthSessionStatus>('loading')
  const [session, setSession] = useState<AuthSession | null>(null)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const operationRef = useRef(0)
  const mountedRef = useRef(false)
  const refreshPromiseRef = useRef<Promise<void> | null>(null)
  const refreshOperationRef = useRef(0)
  const channelRef = useRef<BroadcastChannel | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  function acceptSession(nextSession: AuthSession, operation: number) {
    if (!mountedRef.current || operationRef.current !== operation) return false
    setCsrfToken(nextSession.csrfToken)
    setSession(nextSession)
    setStatus('ready')
    setError(null)
    setRevision((current) => current + 1)
    return true
  }

  function refreshSession(showLoading = false): Promise<void> {
    if (
      refreshPromiseRef.current &&
      refreshOperationRef.current === operationRef.current
    ) return refreshPromiseRef.current

    const operation = ++operationRef.current
    refreshOperationRef.current = operation
    if (showLoading) {
      setStatus('loading')
      setError(null)
    }

    const refreshPromise = getSession()
      .then((nextSession) => { acceptSession(nextSession, operation) })
      .catch((refreshError: unknown) => {
        if (!mountedRef.current || operationRef.current !== operation) return
        setCsrfToken(null)
        setStatus('error')
        setError(errorMessage(refreshError))
      })
      .finally(() => {
        if (refreshPromiseRef.current === refreshPromise) refreshPromiseRef.current = null
      })
    refreshPromiseRef.current = refreshPromise
    return refreshPromise
  }

  useEffect(() => {
    void refreshSession(true)
  }, [retryKey])

  useEffect(() => {
    const refresh = () => { void refreshSession() }
    const unsubscribe = subscribeToSessionChanges(refresh)
    const handleFocus = () => refresh()
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    let channel: BroadcastChannel | null = null
    let handleMessage: ((event: MessageEvent) => void) | null = null

    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(SESSION_CHANNEL_NAME)
      channelRef.current = channel
      handleMessage = (event: MessageEvent) => {
        if (event.data === SESSION_CHANGED_SIGNAL) refresh()
      }
      channel.addEventListener('message', handleMessage)
    }

    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibility)
      if (channel && handleMessage) channel.removeEventListener('message', handleMessage)
      channel?.close()
      if (channelRef.current === channel) channelRef.current = null
    }
  }, [])

  async function runAuthOperation(operationRequest: () => Promise<AuthSession>) {
    const operation = ++operationRef.current
    try {
      const nextSession = await operationRequest()
      if (acceptSession(nextSession, operation)) {
        channelRef.current?.postMessage(SESSION_CHANGED_SIGNAL)
      }
    } catch (operationError) {
      if (operationError instanceof HttpError && operationError.code === 'SESSION_CHANGED') {
        await refreshSession()
      }
      throw operationError
    }
  }

  return (
    <AuthSessionContext.Provider value={{
      status,
      session,
      revision,
      error,
      login: (email, password) => runAuthOperation(() => loginRequest(email, password)),
      register: (email, password) => runAuthOperation(() => registerRequest(email, password)),
      logout: () => runAuthOperation(logoutRequest),
      retry: () => setRetryKey((current) => current + 1),
    }}>
      {children}
    </AuthSessionContext.Provider>
  )
}

export function useAuthSession(): AuthSessionContextValue {
  const context = useContext(AuthSessionContext)
  if (!context) throw new Error('useAuthSession debe usarse dentro de AuthSessionProvider')
  return context
}
