const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'
const UNSAFE_METHODS = new Set(['POST', 'PATCH', 'DELETE'])
const SESSION_INVALID_CODES = new Set(['SESSION_REQUIRED', 'CSRF_INVALID', 'SESSION_CHANGED'])

let csrfToken: string | null = null
const sessionChangeListeners = new Set<() => void>()

export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

export function subscribeToSessionChanges(listener: () => void): () => void {
  sessionChangeListeners.add(listener)
  return () => sessionChangeListeners.delete(listener)
}

export class SessionNotReadyError extends Error {
  constructor() {
    super('La sesión todavía no está lista. Esperá un momento o reintentá la conexión.')
    this.name = 'SessionNotReadyError'
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

interface ErrorDetails {
  message: string
  code?: string
}

async function getErrorDetails(response: Response, fallback: string): Promise<ErrorDetails> {
  try {
    const payload: unknown = await response.json()
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof payload.error === 'string' &&
      payload.error.trim()
    ) {
      return {
        message: payload.error,
        ...('code' in payload && typeof payload.code === 'string' ? { code: payload.code } : {}),
      }
    }
  } catch {
    // Empty and non-JSON responses use the operation-specific fallback.
  }

  return { message: fallback }
}

export async function request<T>(
  path: string,
  errorMessage: string,
  init?: RequestInit,
  hasResponseBody = true,
): Promise<T> {
  let response: Response
  const method = init?.method?.toUpperCase() ?? 'GET'
  const isUnsafe = UNSAFE_METHODS.has(method)

  if (isUnsafe && !csrfToken) throw new SessionNotReadyError()

  const headers = new Headers(init?.headers)
  if (isUnsafe) headers.set('X-CSRF-Token', csrfToken!)
  const requestInit: RequestInit = {
    ...init,
    credentials: 'include',
    ...(!headers.keys().next().done ? { headers } : {}),
  }

  try {
    response = await fetch(`${API_URL}${path}`, requestInit)
  } catch (error) {
    if (
      init?.signal?.aborted ||
      (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
    ) throw error
    throw new Error(`No se pudo conectar con el backend en ${API_URL}`)
  }

  if (!response.ok) {
    const details = await getErrorDetails(response, errorMessage)
    if (details.code && SESSION_INVALID_CODES.has(details.code)) {
      for (const listener of sessionChangeListeners) listener()
    }
    throw new HttpError(response.status, details.message, details.code)
  }
  if (!hasResponseBody) return undefined as T
  return response.json() as Promise<T>
}
