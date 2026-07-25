import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { getSession, login as loginRequest } from '../api/auth'
import { HttpError, request } from '../api/http'
import { AuthSessionProvider, useAuthSession } from './AuthSessionContext'

vi.mock('../api/auth', () => ({
  getSession: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  register: vi.fn(),
}))

const mockedGetSession = vi.mocked(getSession)
const mockedLogin = vi.mocked(loginRequest)

class BroadcastChannelMock {
  static instances: BroadcastChannelMock[] = []
  readonly messages: unknown[] = []
  readonly listeners = new Set<(event: MessageEvent) => void>()
  close = vi.fn()

  constructor(readonly name: string) {
    BroadcastChannelMock.instances.push(this)
  }

  postMessage(message: unknown) {
    this.messages.push(message)
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
    this.listeners.delete(listener)
  }

  receive(message: unknown) {
    for (const listener of this.listeners) listener(new MessageEvent('message', { data: message }))
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function wrapper({ children }: { children: ReactNode }) {
  return <StrictMode><AuthSessionProvider>{children}</AuthSessionProvider></StrictMode>
}

describe('AuthSessionProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    BroadcastChannelMock.instances = []
    vi.stubGlobal('BroadcastChannel', BroadcastChannelMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('renders children without waiting for the bootstrap GET', () => {
    mockedGetSession.mockReturnValue(new Promise(() => {}))

    render(<AuthSessionProvider><p>Contenido público</p></AuthSessionProvider>)

    expect(screen.getByText('Contenido público')).toBeInTheDocument()
  })

  it('bootstraps safely in StrictMode and becomes ready', async () => {
    mockedGetSession.mockResolvedValue({ user: null, csrfToken: 'csrf-anon' })

    const { result } = renderHook(useAuthSession, { wrapper })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.session?.user).toBeNull()
    expect(result.current.revision).toBe(1)
  })

  it('does not let an older bootstrap overwrite a newer login', async () => {
    const bootstrap = deferred<{ user: null; csrfToken: string }>()
    mockedGetSession.mockReturnValue(bootstrap.promise)
    mockedLogin.mockResolvedValue({
      user: { id: 'user-1', email: 'person@example.com' },
      csrfToken: 'csrf-user',
    })
    const { result } = renderHook(useAuthSession, {
      wrapper: ({ children }) => <AuthSessionProvider>{children}</AuthSessionProvider>,
    })

    await act(async () => result.current.login('person@example.com', 'password-1234'))
    await act(async () => bootstrap.resolve({ user: null, csrfToken: 'csrf-old' }))

    expect(result.current.session?.user?.email).toBe('person@example.com')
    expect(result.current.revision).toBe(1)
  })

  it('exposes bootstrap errors and retries them', async () => {
    mockedGetSession
      .mockRejectedValueOnce(new Error('Sin backend'))
      .mockResolvedValueOnce({ user: null, csrfToken: 'csrf-recovered' })
    const { result } = renderHook(useAuthSession, {
      wrapper: ({ children }) => <AuthSessionProvider>{children}</AuthSessionProvider>,
    })

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toBe('Sin backend')
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })

  it('broadcasts only an opaque signal after an auth operation', async () => {
    mockedGetSession.mockResolvedValue({ user: null, csrfToken: 'csrf-anon' })
    mockedLogin.mockResolvedValue({
      user: { id: 'user-1', email: 'person@example.com' },
      csrfToken: 'csrf-secret',
    })
    const { result } = renderHook(useAuthSession, {
      wrapper: ({ children }) => <AuthSessionProvider>{children}</AuthSessionProvider>,
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    await act(async () => result.current.login('person@example.com', 'password-1234'))

    expect(BroadcastChannelMock.instances[0].messages).toEqual(['session-changed'])
    expect(JSON.stringify(BroadcastChannelMock.instances[0].messages)).not.toContain('csrf-secret')
    expect(JSON.stringify(BroadcastChannelMock.instances[0].messages)).not.toContain('person@example.com')
  })

  it('refreshes from an opaque broadcast and ignores an older in-flight result', async () => {
    const externalRefresh = deferred<{ user: null; csrfToken: string }>()
    mockedGetSession
      .mockResolvedValueOnce({ user: null, csrfToken: 'csrf-anon' })
      .mockReturnValueOnce(externalRefresh.promise)
    mockedLogin.mockResolvedValue({
      user: { id: 'user-1', email: 'person@example.com' },
      csrfToken: 'csrf-user',
    })
    const { result } = renderHook(useAuthSession, {
      wrapper: ({ children }) => <AuthSessionProvider>{children}</AuthSessionProvider>,
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => BroadcastChannelMock.instances[0].receive('session-changed'))
    await waitFor(() => expect(mockedGetSession).toHaveBeenCalledTimes(2))
    await act(async () => result.current.login('person@example.com', 'password-1234'))
    await act(async () => externalRefresh.resolve({ user: null, csrfToken: 'csrf-stale' }))

    expect(result.current.session?.user?.email).toBe('person@example.com')
    expect(result.current.revision).toBe(2)
  })

  it('refreshes on focus with BroadcastChannel available and deduplicates visibility refreshes', async () => {
    const refresh = deferred<{ user: null; csrfToken: string }>()
    mockedGetSession
      .mockResolvedValueOnce({ user: null, csrfToken: 'csrf-anon' })
      .mockReturnValueOnce(refresh.promise)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const { result } = renderHook(useAuthSession, {
      wrapper: ({ children }) => <AuthSessionProvider>{children}</AuthSessionProvider>,
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(mockedGetSession).toHaveBeenCalledTimes(2)
    await act(async () => refresh.resolve({ user: null, csrfToken: 'csrf-refreshed' }))
    expect(result.current.revision).toBe(2)
  })

  it('cleans up its channel and fallback listeners', async () => {
    mockedGetSession.mockResolvedValue({ user: null, csrfToken: 'csrf-anon' })
    const channelView = render(<AuthSessionProvider><span /></AuthSessionProvider>)
    await waitFor(() => expect(mockedGetSession).toHaveBeenCalledTimes(1))
    const channel = BroadcastChannelMock.instances[0]

    channelView.unmount()

    expect(channel.close).toHaveBeenCalledTimes(1)
    expect(channel.listeners).toHaveLength(0)
    mockedGetSession.mockClear()
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mockedGetSession).not.toHaveBeenCalled()

    vi.stubGlobal('BroadcastChannel', undefined)
    mockedGetSession.mockClear()
    const fallbackView = render(<AuthSessionProvider><span /></AuthSessionProvider>)
    await waitFor(() => expect(mockedGetSession).toHaveBeenCalledTimes(1))
    fallbackView.unmount()
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mockedGetSession).toHaveBeenCalledTimes(1)
  })

  it('refreshes after SESSION_CHANGED but rejects without retrying the auth operation', async () => {
    mockedGetSession
      .mockResolvedValueOnce({ user: null, csrfToken: 'csrf-anon' })
      .mockResolvedValueOnce({
        user: { id: 'user-2', email: 'other@example.com' },
        csrfToken: 'csrf-current',
      })
    mockedLogin.mockRejectedValue(new HttpError(409, 'La sesión cambió en otra pestaña', 'SESSION_CHANGED'))
    const { result } = renderHook(useAuthSession, {
      wrapper: ({ children }) => <AuthSessionProvider>{children}</AuthSessionProvider>,
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    await act(async () => {
      await expect(result.current.login('person@example.com', 'password-1234'))
        .rejects.toThrow('La sesión cambió en otra pestaña')
    })

    await waitFor(() => expect(result.current.session?.user?.email).toBe('other@example.com'))
    expect(mockedLogin).toHaveBeenCalledTimes(1)
    expect(mockedGetSession).toHaveBeenCalledTimes(2)
  })

  it('refreshes when a documentary mutation reports an invalid session without retrying it', async () => {
    mockedGetSession
      .mockResolvedValueOnce({ user: null, csrfToken: 'csrf-anon' })
      .mockResolvedValueOnce({ user: null, csrfToken: 'csrf-renewed' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'CSRF inválido',
      code: 'CSRF_INVALID',
    }), { status: 403 }))
    const { result } = renderHook(useAuthSession, {
      wrapper: ({ children }) => <AuthSessionProvider>{children}</AuthSessionProvider>,
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    await act(async () => {
      await expect(request('/documents/doc-1', 'No se pudo guardar', { method: 'PATCH' }))
        .rejects.toMatchObject({ status: 403 })
    })

    await waitFor(() => expect(mockedGetSession).toHaveBeenCalledTimes(2))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result.current.revision).toBe(2)
  })
})
