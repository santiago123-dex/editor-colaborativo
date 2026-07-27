import { request } from './http'

export interface AuthUser {
  id: string
  email: string
}

export interface AuthSession {
  user: AuthUser | null
  csrfToken: string
}

export function getSession(signal?: AbortSignal): Promise<AuthSession> {
  return request(
    '/auth/session',
    'No se pudo iniciar la sesión',
    signal ? { signal } : undefined,
  )
}

function submitCredentials(path: '/auth/login' | '/auth/register', email: string, password: string) {
  return request<AuthSession>(path, 'No se pudo completar la autenticación', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
}

export function login(email: string, password: string): Promise<AuthSession> {
  return submitCredentials('/auth/login', email, password)
}

export function register(email: string, password: string): Promise<AuthSession> {
  return submitCredentials('/auth/register', email, password)
}

export function logout(): Promise<AuthSession> {
  return request('/auth/logout', 'No se pudo cerrar la sesión', { method: 'POST' })
}
