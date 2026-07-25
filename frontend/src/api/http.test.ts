import {
  request,
  setCsrfToken,
  SessionNotReadyError,
  subscribeToSessionChanges,
} from './http'

describe('HTTP client', () => {
  afterEach(() => setCsrfToken(null))

  it('includes credentials in every request', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true })))

    await request('/health', 'Error')

    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/health$/), {
      credentials: 'include',
    })
  })

  it('merges the in-memory CSRF token without losing caller headers', async () => {
    setCsrfToken('csrf-secret')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true })))

    await request('/documents/doc-1', 'Error', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Feature': 'title' },
      body: '{}',
    })

    const init = vi.mocked(fetch).mock.calls[0][1]
    const headers = new Headers(init?.headers)
    expect(init).toMatchObject({ method: 'PATCH', credentials: 'include', body: '{}' })
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-Feature')).toBe('title')
    expect(headers.get('X-CSRF-Token')).toBe('csrf-secret')
  })

  it.each(['POST', 'PATCH', 'DELETE'])('does not send unsafe %s without a ready token', async (method) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(request('/documents', 'Error', { method })).rejects.toBeInstanceOf(SessionNotReadyError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never persists or puts the CSRF token in the URL', async () => {
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem')
    setCsrfToken('private-token')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true })))

    await request('/documents', 'Error', { method: 'POST' })

    expect(storageSpy).not.toHaveBeenCalled()
    expect(String(vi.mocked(fetch).mock.calls[0][0])).not.toContain('private-token')
  })

  it('preserves a structured error code', async () => {
    setCsrfToken('csrf-current')
    const listener = vi.fn()
    const unsubscribe = subscribeToSessionChanges(listener)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'La sesión cambió',
      code: 'SESSION_CHANGED',
    }), { status: 409 }))

    await expect(request('/auth/logout', 'Error', { method: 'POST' })).rejects.toMatchObject({
      status: 409,
      code: 'SESSION_CHANGED',
      message: 'La sesión cambió',
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it.each([
    [401, 'SESSION_REQUIRED'],
    [403, 'CSRF_INVALID'],
  ])('notifies once after a request fails with %s/%s without retrying', async (status, code) => {
    setCsrfToken('csrf-current')
    const listener = vi.fn()
    const unsubscribe = subscribeToSessionChanges(listener)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'Sesión inválida',
      code,
    }), {
      status,
    }))

    await expect(request('/documents/doc-1', 'Error', { method: 'PATCH' })).rejects.toMatchObject({ status })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('does not emit the session signal for credentials or document authorization errors', async () => {
    setCsrfToken('csrf-current')
    const listener = vi.fn()
    const unsubscribe = subscribeToSessionChanges(listener)
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'No podés eliminar este documento',
        code: 'DOCUMENT_FORBIDDEN',
      }), { status: 403 }))

    await expect(request('/auth/login', 'Error', { method: 'POST' })).rejects.toMatchObject({ status: 401 })
    await expect(request('/documents/doc-1', 'Error', { method: 'DELETE' })).rejects.toMatchObject({
      status: 403,
      code: 'DOCUMENT_FORBIDDEN',
    })

    expect(listener).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})
