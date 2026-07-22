const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

async function getErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload: unknown = await response.json()
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof payload.error === 'string' &&
      payload.error.trim()
    ) return payload.error
  } catch {
    // Empty and non-JSON responses use the operation-specific fallback.
  }

  return fallback
}

export async function request<T>(
  path: string,
  errorMessage: string,
  init?: RequestInit,
  hasResponseBody = true,
): Promise<T> {
  let response: Response

  try {
    response = init ? await fetch(`${API_URL}${path}`, init) : await fetch(`${API_URL}${path}`)
  } catch (error) {
    if (
      init?.signal?.aborted ||
      (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
    ) throw error
    throw new Error(`No se pudo conectar con el backend en ${API_URL}`)
  }

  if (!response.ok) {
    throw new HttpError(response.status, await getErrorMessage(response, errorMessage))
  }
  if (!hasResponseBody) return undefined as T
  return response.json() as Promise<T>
}
