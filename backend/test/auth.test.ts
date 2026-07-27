import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { initializeSchema } from '../src/db/schema.js'
import { createCsrfToken } from '../src/auth/crypto.js'
import type { AuthHttpOptions, AuthRequest } from '../src/auth/http.js'
import { AuthRepository, SessionChangedError } from '../src/auth/repository.js'
import { createAuthRouter } from '../src/routes/auth.js'
import { createCollaborationServer, type CollaborationServer } from '../src/server.js'

const ORIGIN = 'http://localhost:5173'
const OTHER_ORIGIN = 'http://evil.example'
const CSRF_SECRET = 'test-csrf-secret-at-least-32-characters'
const FIXED_TIME = Date.parse('2030-01-02T03:04:05.678Z')

const cookieValue = (setCookie: string | string[] | undefined, name = 'editor_session') => {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (!header) throw new Error('Missing Set-Cookie')
  const match = new RegExp(`^${name}=([^;]+)`).exec(header)
  if (!match) throw new Error(`Missing ${name} cookie`)
  return match[1]
}

const openSession = async (backend: CollaborationServer) => {
  const agent = request.agent(backend.app)
  const response = await agent.get('/auth/session').expect(200)
  return { agent, csrfToken: response.body.csrfToken as string, response }
}

const unsafe = (
  agent: ReturnType<typeof request.agent>,
  method: 'post' | 'patch' | 'delete',
  path: string,
  csrfToken: string,
) => agent[method](path).set('Origin', ORIGIN).set('X-CSRF-Token', csrfToken)

describe('authentication schema migration', () => {
  it('preserves legacy documents and messages while adding idempotent auth and ownership schema', () => {
    const database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    database.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        state BLOB NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        UNIQUE (document_id, client_message_id)
      );
      INSERT INTO documents VALUES ('legacy', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', 'Legacy', X'00');
      INSERT INTO messages VALUES ('message', 'legacy', 'client-message', 'Ana', 'Hola', '2025-01-01T00:00:00.000Z');
    `)

    initializeSchema(database)
    initializeSchema(database)

    const columns = database.pragma('table_info(documents)') as Array<{ name: string }>
    expect(columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['owner_user_id', 'owner_session_id']),
    )
    expect(database.prepare('SELECT owner_user_id, owner_session_id FROM documents').get()).toEqual({
      owner_user_id: null,
      owner_session_id: null,
    })
    expect(database.prepare('SELECT author, content FROM messages').get()).toEqual({ author: 'Ana', content: 'Hola' })
    expect(database.pragma('table_info(users)')).not.toEqual([])
    expect(database.pragma('table_info(sessions)')).not.toEqual([])
    database.close()
  })
})

describe('optional authentication', () => {
  let backend: CollaborationServer | undefined
  let directory: string | undefined

  const start = async (overrides: Partial<Parameters<typeof createCollaborationServer>[0]> = {}) => {
    directory = await mkdtemp(join(tmpdir(), 'auth-backend-'))
    backend = createCollaborationServer({
      databasePath: join(directory, 'database.sqlite'),
      allowedOrigins: [ORIGIN],
      csrfSecret: CSRF_SECRET,
      secureCookies: false,
      now: () => new Date(FIXED_TIME),
      ...overrides,
    })
    return backend
  }

  afterEach(async () => {
    vi.restoreAllMocks()
    await backend?.close()
    if (directory) await rm(directory, { recursive: true, force: true })
    backend = undefined
    directory = undefined
  })

  it('creates and renews an opaque anonymous session without storing the raw cookie', async () => {
    const server = await start()
    const first = await request(server.app).get('/auth/session').expect(200)
    expect(first.body).toEqual({ user: null, csrfToken: expect.any(String) })
    expect(first.headers['cache-control']).toBe('no-store')
    const rawToken = cookieValue(first.headers['set-cookie'])
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.headers['set-cookie'][0]).toContain('HttpOnly')
    expect(first.headers['set-cookie'][0]).toContain('SameSite=Lax')
    expect(first.headers['set-cookie'][0]).not.toContain('Secure')

    const database = new Database(join(directory!, 'database.sqlite'))
    const stored = database.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string }
    expect(stored.token_hash).toBe(createHash('sha256').update(rawToken).digest('hex'))
    expect(stored.token_hash).not.toContain(rawToken)
    database.close()

    const reused = await request(server.app)
      .get('/auth/session')
      .set('Cookie', `editor_session=${rawToken}`)
      .expect(200)
    expect(reused.body).toEqual(first.body)
    expect(cookieValue(reused.headers['set-cookie'])).toBe(rawToken)
  })

  it('replaces a stale session when renewal loses its compare-and-swap', async () => {
    const server = await start()
    const first = await request(server.app).get('/auth/session').expect(200)
    const firstToken = cookieValue(first.headers['set-cookie'])
    const renew = vi.spyOn(AuthRepository.prototype, 'renewSession').mockReturnValueOnce(false)

    const replaced = await request(server.app)
      .get('/auth/session')
      .set('Cookie', `editor_session=${firstToken}`)
      .expect(200)

    expect(renew).toHaveBeenCalledOnce()
    expect(cookieValue(replaced.headers['set-cookie'])).not.toBe(firstToken)
    expect(replaced.body).toEqual({ user: null, csrfToken: expect.any(String) })
    expect(replaced.body.csrfToken).not.toBe(first.body.csrfToken)
  })

  it('expires sessions using the configured clock and TTL', async () => {
    let currentTime = FIXED_TIME
    const server = await start({ now: () => new Date(currentTime), sessionTtlMs: 1_000 })
    const first = await request(server.app).get('/auth/session').expect(200)
    const firstToken = cookieValue(first.headers['set-cookie'])
    currentTime += 1_001
    const expired = await request(server.app)
      .get('/auth/session')
      .set('Cookie', `editor_session=${firstToken}`)
      .expect(200)
    expect(cookieValue(expired.headers['set-cookie'])).not.toBe(firstToken)
    expect(expired.body.user).toBeNull()
  })

  it('slides valid expiration from now and preserves expired sessions that own documents', async () => {
    let currentTime = FIXED_TIME
    const server = await start({ now: () => new Date(currentTime), sessionTtlMs: 1_000 })
    const opened = await request(server.app).get('/auth/session').expect(200)
    const token = cookieValue(opened.headers['set-cookie'])
    const database = new Database(join(directory!, 'database.sqlite'))
    const session = database.prepare('SELECT id FROM sessions').get() as { id: string }

    currentTime += 500
    await request(server.app)
      .get('/auth/session')
      .set('Cookie', `editor_session=${token}`)
      .expect(200)
      .expect('Set-Cookie', /Max-Age=1/)
    expect((database.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(session.id) as { expires_at: string }).expires_at)
      .toBe(new Date(currentTime + 1_000).toISOString())

    database.prepare(
      `INSERT INTO documents
        (id, created_at, updated_at, title, state, owner_session_id)
       VALUES (?, ?, ?, '', X'00', ?)`,
    ).run('owned', new Date(currentTime).toISOString(), new Date(currentTime).toISOString(), session.id)
    currentTime += 1_001
    await request(server.app)
      .get('/auth/session')
      .set('Cookie', `editor_session=${token}`)
      .expect(200)
    expect(database.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id)).toEqual({ id: session.id })
    database.close()
  })

  it('sets production-compatible flags and supports a custom cookie name', async () => {
    const server = await start({ secureCookies: true, sessionCookieName: 'collab_session' })
    const response = await request(server.app).get('/auth/session').expect(200)
    expect(response.headers['set-cookie'][0]).toContain('collab_session=')
    expect(response.headers['set-cookie'][0]).toContain('SameSite=None')
    expect(response.headers['set-cookie'][0]).toContain('Secure')
    expect(response.headers['set-cookie'][0]).toContain('Max-Age=2592000')
  })

  it('uses environment cookie defaults and rejects weak production CSRF secrets', async () => {
    const development = await start()
    const developmentCookie = (await request(development.app).get('/auth/session')).headers['set-cookie'][0]
    expect(developmentCookie).toMatch(/^editor_session=/)
    expect(developmentCookie).toContain('Path=/')
    expect(developmentCookie).not.toContain('Domain=')
    await development.close()
    backend = undefined

    expect(() => createCollaborationServer({
      databasePath: ':memory:',
      production: true,
      csrfSecret: 'too-short',
    })).toThrow(/CSRF_SECRET.*32/)
    const production = createCollaborationServer({
      databasePath: ':memory:',
      production: true,
      csrfSecret: CSRF_SECRET,
    })
    backend = production
    const productionCookie = (await request(production.app).get('/auth/session')).headers['set-cookie'][0]
    expect(productionCookie).toMatch(/^__Host-editor_session=/)
    expect(productionCookie).toContain('Secure')
    expect(productionCookie).toContain('Path=/')
    expect(productionCookie).not.toContain('Domain=')
  })

  it('rejects __Host- cookie names unless secure cookies are enabled', () => {
    expect(() => createCollaborationServer({
      databasePath: ':memory:',
      csrfSecret: CSRF_SECRET,
      sessionCookieName: '__Host-custom_session',
      secureCookies: false,
    })).toThrow(/__Host-.*secureCookies/)

    expect(() => createCollaborationServer({
      databasePath: ':memory:',
      production: true,
      csrfSecret: CSRF_SECRET,
      secureCookies: false,
    })).toThrow(/__Host-.*secureCookies/)
  })

  it('uses an exact credentialed CORS allowlist and rejects unsafe CSRF/origin failures', async () => {
    const server = await start()
    await request(server.app)
      .options('/auth/login')
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .expect(204)
      .expect('Access-Control-Allow-Origin', ORIGIN)
      .expect('Access-Control-Allow-Credentials', 'true')
    const deniedPreflight = await request(server.app)
      .options('/auth/login')
      .set('Origin', OTHER_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
    expect(deniedPreflight.headers['access-control-allow-origin']).toBeUndefined()

    const { agent, csrfToken } = await openSession(server)
    await agent.post('/documents').expect(403).expect({ error: 'Origin not allowed', code: 'ORIGIN_INVALID' })
    await agent
      .post('/documents')
      .set('Origin', OTHER_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .expect(403)
    await agent.post('/documents').set('Origin', ORIGIN).expect(403)
    await agent
      .post('/documents')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', 'invalid')
      .expect(403)
    await request(server.app)
      .post('/documents')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .expect(401)
  })

  it('validates registration, normalizes email, rejects duplicates and rotates the session', async () => {
    const server = await start()
    const { agent, csrfToken, response } = await openSession(server)
    const oldToken = cookieValue(response.headers['set-cookie'])

    for (const body of [
      { email: 'invalid', password: 'a'.repeat(12) },
      { email: `${'a'.repeat(250)}@x.com`, password: 'a'.repeat(12) },
      { email: 'a@example.com', password: 'short' },
      { email: 'a@example.com', password: 'a'.repeat(129) },
    ]) {
      await unsafe(agent, 'post', '/auth/register', csrfToken).send(body).expect(400)
    }

    const registered = await unsafe(agent, 'post', '/auth/register', csrfToken)
      .send({ email: '  Person@Example.COM ', password: 'correct horse battery' })
      .expect(201)
    expect(registered.body).toEqual({
      user: { id: expect.any(String), email: 'person@example.com' },
      csrfToken: expect.any(String),
    })
    expect(cookieValue(registered.headers['set-cookie'])).not.toBe(oldToken)

    const duplicate = await openSession(server)
    await unsafe(duplicate.agent, 'post', '/auth/register', duplicate.csrfToken)
      .send({ email: 'PERSON@example.com', password: 'another password' })
      .expect(409)
      .expect({ error: 'Email already registered', code: 'EMAIL_EXISTS' })
  })

  it('rate limits register and login per IP and normalized email and resets after the window', async () => {
    let currentTime = FIXED_TIME
    const server = await start({
      now: () => new Date(currentTime),
      authRateLimitMax: 2,
      authRateLimitWindowMs: 1_000,
    })
    const current = await openSession(server)
    const credentials = { email: ' Missing@Example.com ', password: 'correct horse battery' }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await unsafe(current.agent, 'post', '/auth/login', current.csrfToken).send(credentials).expect(401)
    }
    await unsafe(current.agent, 'post', '/auth/login', current.csrfToken)
      .send(credentials)
      .expect(429)
      .expect('Retry-After', '1')
      .expect({ error: 'Too many authentication attempts', code: 'RATE_LIMITED' })

    currentTime += 1_001
    await unsafe(current.agent, 'post', '/auth/login', current.csrfToken).send(credentials).expect(401)
    await unsafe(current.agent, 'post', '/auth/login', current.csrfToken)
      .send({ ...credentials, email: 'other@example.com' })
      .expect(401)

    const registration = await openSession(server)
    await unsafe(registration.agent, 'post', '/auth/register', registration.csrfToken)
      .send({ email: 'limited@example.com', password: 'correct horse battery' })
      .expect(201)
    const duplicateSession = await openSession(server)
    await unsafe(duplicateSession.agent, 'post', '/auth/register', duplicateSession.csrfToken)
      .send({ email: 'limited@example.com', password: 'another password' })
      .expect(409)
    await unsafe(duplicateSession.agent, 'post', '/auth/register', duplicateSession.csrfToken)
      .send({ email: 'limited@example.com', password: 'another password' })
      .expect(429)
  })

  it('allows only one concurrent rotation and rolls a stale registration back without a cookie', async () => {
    const server = await start({ authRateLimitMax: 20 })
    const opened = await request(server.app).get('/auth/session').expect(200)
    const token = cookieValue(opened.headers['set-cookie'])
    const headers = {
      Cookie: `editor_session=${token}`,
      Origin: ORIGIN,
      'X-CSRF-Token': opened.body.csrfToken as string,
    }
    const document = await request(server.app).post('/documents').set(headers).expect(201)
    const responses = await Promise.all([
      request(server.app).post('/auth/register').set(headers).send({ email: 'first@example.com', password: 'correct horse battery' }),
      request(server.app).post('/auth/register').set(headers).send({ email: 'second@example.com', password: 'correct horse battery' }),
    ])
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409])
    const stale = responses.find(({ status }) => status === 409)!
    expect(stale.body).toEqual({ error: 'Session changed', code: 'SESSION_CHANGED' })
    expect(stale.headers['set-cookie']).toBeUndefined()

    const database = new Database(join(directory!, 'database.sqlite'))
    expect((database.prepare('SELECT count(*) AS count FROM users').get() as { count: number }).count).toBe(1)
    expect((database.prepare('SELECT count(*) AS count FROM sessions').get() as { count: number }).count).toBe(1)
    const user = database.prepare('SELECT id FROM users').get() as { id: string }
    expect(database.prepare('SELECT owner_user_id, owner_session_id FROM documents WHERE id = ?').get(document.body.id))
      .toEqual({ owner_user_id: user.id, owner_session_id: null })
    database.close()
  })

  it('allows only one concurrent login rotation', async () => {
    const server = await start({ authRateLimitMax: 20 })
    const registration = await openSession(server)
    await unsafe(registration.agent, 'post', '/auth/register', registration.csrfToken)
      .send({ email: 'person@example.com', password: 'correct horse battery' })
      .expect(201)
    const opened = await request(server.app).get('/auth/session').expect(200)
    const headers = {
      Cookie: `editor_session=${cookieValue(opened.headers['set-cookie'])}`,
      Origin: ORIGIN,
      'X-CSRF-Token': opened.body.csrfToken as string,
    }
    const credentials = { email: 'person@example.com', password: 'correct horse battery' }
    const responses = await Promise.all([
      request(server.app).post('/auth/login').set(headers).send(credentials),
      request(server.app).post('/auth/login').set(headers).send(credentials),
    ])
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409])
    const stale = responses.find(({ status }) => status === 409)!
    expect(stale.body).toEqual({ error: 'Session changed', code: 'SESSION_CHANGED' })
    expect(stale.headers['set-cookie']).toBeUndefined()
  })

  it('logs in with generic failures, rotates tokens, logs out to a fresh anonymous session, and logs in again', async () => {
    const server = await start()
    const registration = await openSession(server)
    const registered = await unsafe(registration.agent, 'post', '/auth/register', registration.csrfToken)
      .send({ email: 'person@example.com', password: 'correct horse battery' })
      .expect(201)
    const registeredToken = cookieValue(registered.headers['set-cookie'])

    const stranger = await openSession(server)
    for (const credentials of [
      { email: 'missing@example.com', password: 'correct horse battery' },
      { email: 'person@example.com', password: 'wrong password!' },
    ]) {
      await unsafe(stranger.agent, 'post', '/auth/login', stranger.csrfToken)
        .send(credentials)
        .expect(401)
        .expect({ error: 'Invalid email or password', code: 'INVALID_CREDENTIALS' })
    }

    const login = await unsafe(stranger.agent, 'post', '/auth/login', stranger.csrfToken)
      .send({ email: ' PERSON@example.com ', password: 'correct horse battery' })
      .expect(200)
    expect(login.body.user.email).toBe('person@example.com')
    expect(cookieValue(login.headers['set-cookie'])).not.toBe(registeredToken)

    const logout = await unsafe(stranger.agent, 'post', '/auth/logout', login.body.csrfToken).expect(200)
    expect(logout.body).toEqual({ user: null, csrfToken: expect.any(String) })
    expect(cookieValue(logout.headers['set-cookie'])).not.toBe(cookieValue(login.headers['set-cookie']))

    await unsafe(stranger.agent, 'post', '/auth/login', logout.body.csrfToken)
      .send({ email: 'person@example.com', password: 'correct horse battery' })
      .expect(200)
  })

  it('keeps legacy documents non-deletable and checks ownership before active state', async () => {
    const server = await start()
    const database = new Database(join(directory!, 'database.sqlite'))
    const timestamp = new Date(FIXED_TIME).toISOString()
    database
      .prepare('INSERT INTO documents (id, created_at, updated_at, title, state) VALUES (?, ?, ?, ?, ?)')
      .run(
        '00000000-0000-4000-8000-000000000001',
        timestamp,
        timestamp,
        'Legacy',
        Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())),
      )
    database.close()
    server.httpServer.listen(0, '127.0.0.1')
    await once(server.httpServer, 'listening')
    const { port } = server.httpServer.address() as AddressInfo
    const current = await openSession(server)
    expect((await current.agent.get('/documents/00000000-0000-4000-8000-000000000001')).body.canDelete).toBe(false)

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/00000000-0000-4000-8000-000000000001`, {
      origin: ORIGIN,
    })
    await once(socket, 'open')
    await unsafe(
      current.agent,
      'delete',
      '/documents/00000000-0000-4000-8000-000000000001',
      current.csrfToken,
    )
      .expect(403)
      .expect({ error: 'Forbidden', code: 'DOCUMENT_FORBIDDEN' })
    socket.close()
    await once(socket, 'close')
  })
})

describe('session rotation compare-and-swap', () => {
  it('throws on stale rotation before inserting or claiming documents', () => {
    const database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    initializeSchema(database)
    const repository = new AuthRepository(database, 1_000)
    const now = new Date(FIXED_TIME)
    const original = repository.createAnonymous(now)
    database.prepare(
      `INSERT INTO documents
        (id, created_at, updated_at, title, state, owner_session_id)
       VALUES ('owned', ?, ?, '', X'00', ?)`,
    ).run(now.toISOString(), now.toISOString(), original.id)
    const first = repository.rotate(original.id, null, now)

    expect(() => repository.rotate(original.id, null, now)).toThrow(SessionChangedError)
    expect((database.prepare('SELECT count(*) AS count FROM sessions').get() as { count: number }).count).toBe(1)
    expect(database.prepare('SELECT owner_session_id FROM documents WHERE id = ?').get('owned')).toEqual({
      owner_session_id: original.id,
    })
    expect(database.prepare('SELECT id FROM sessions').get()).toEqual({ id: first.id })
    database.close()
  })

  it('maps a stale logout to 409 without setting a cookie', async () => {
    const database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    initializeSchema(database)
    const repository = new AuthRepository(database, 1_000)
    const now = new Date(FIXED_TIME)
    const stale = repository.createAnonymous(now)
    repository.rotate(stale.id, null, now)
    const options: AuthHttpOptions = {
      allowedOrigins: new Set([ORIGIN]),
      cookieName: 'editor_session',
      csrfSecret: CSRF_SECRET,
      secureCookies: false,
      sessionTtlMs: 1_000,
      authRateLimitMax: 5,
      authRateLimitWindowMs: 1_000,
      now: () => now,
    }
    const app = express()
    app.use(express.json())
    app.use((request: AuthRequest, _response, next) => {
      request.session = stale
      next()
    })
    app.use('/auth', createAuthRouter(repository, options))

    const response = await request(app)
      .post('/auth/logout')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', createCsrfToken(CSRF_SECRET, stale.rawToken))
      .expect(409)
      .expect({ error: 'Session changed', code: 'SESSION_CHANGED' })
    expect(response.headers['set-cookie']).toBeUndefined()
    database.close()
  })
})
