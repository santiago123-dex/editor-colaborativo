import { getSession, login, logout, register } from './auth'
import { setCsrfToken } from './http'

const anonymousSession = { user: null, csrfToken: 'csrf-1' }

describe('auth API', () => {
  beforeEach(() => setCsrfToken('csrf-current'))
  afterEach(() => setCsrfToken(null))

  it('uses the exact auth endpoints and payloads', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
      new Response(JSON.stringify(anonymousSession), { status: 200 })
    ))

    await getSession()
    await login('person@example.com', 'password-1234')
    await register('person@example.com', 'password-1234')
    await logout()

    const calls = vi.mocked(fetch).mock.calls
    expect(calls.map(([url]) => String(url).replace(/^.*\/auth/, '/auth'))).toEqual([
      '/auth/session', '/auth/login', '/auth/register', '/auth/logout',
    ])
    expect(calls[1][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ email: 'person@example.com', password: 'password-1234' }),
    })
    expect(new Headers(calls[1][1]?.headers).get('Content-Type')).toBe('application/json')
  })
})
