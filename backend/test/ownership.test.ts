import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createCollaborationServer, type CollaborationServer } from '../src/server.js'

const ORIGIN = 'http://localhost:5173'
const OTHER_ORIGIN = 'http://evil.example'

const session = async (backend: CollaborationServer) => {
  const agent = request.agent(backend.app)
  const response = await agent.get('/auth/session').expect(200)
  return {
    agent,
    csrfToken: response.body.csrfToken as string,
    unsafe(method: 'post' | 'patch' | 'delete', path: string, csrf = response.body.csrfToken as string) {
      return agent[method](path).set('Origin', ORIGIN).set('X-CSRF-Token', csrf)
    },
  }
}

describe('document ownership', () => {
  let backend: CollaborationServer
  let baseUrl: string

  beforeEach(async () => {
    backend = createCollaborationServer({
      databasePath: ':memory:',
      allowedOrigins: [ORIGIN],
      csrfSecret: 'test-csrf-secret-at-least-32-characters',
      secureCookies: false,
    })
    backend.httpServer.listen(0, '127.0.0.1')
    await once(backend.httpServer, 'listening')
    const { port } = backend.httpServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterEach(async () => backend.close())

  it('keeps POST exact and exposes canDelete only to the anonymous creator', async () => {
    const owner = await session(backend)
    const other = await session(backend)
    const created = await owner.unsafe('post', '/documents').expect(201)
    expect(created.body).toEqual({ id: expect.any(String), createdAt: expect.any(String) })

    expect((await owner.agent.get('/documents')).body[0].canDelete).toBe(true)
    expect((await owner.agent.get(`/documents/${created.body.id}`)).body.canDelete).toBe(true)
    expect((await other.agent.get('/documents')).body[0].canDelete).toBe(false)
    expect((await request(backend.app).get(`/documents/${created.body.id}`)).body.canDelete).toBe(false)

    const patched = await owner.unsafe('patch', `/documents/${created.body.id}`)
      .send({ title: 'Shared' })
      .expect(200)
    expect(patched.body.canDelete).toBe(true)
    await other.unsafe('patch', `/documents/${created.body.id}`)
      .send({ title: 'Still collaborative' })
      .expect(200)
    await other.unsafe('delete', `/documents/${created.body.id}`)
      .expect(403)
      .expect({ error: 'Forbidden', code: 'DOCUMENT_FORBIDDEN' })
    await owner.unsafe('delete', `/documents/${created.body.id}`).expect(204)
  })

  it('claims anonymous documents on register and login while logout temporarily loses permission', async () => {
    const owner = await session(backend)
    const anonymousDocument = await owner.unsafe('post', '/documents').expect(201)
    const registered = await owner.unsafe('post', '/auth/register')
      .send({ email: 'owner@example.com', password: 'correct horse battery' })
      .expect(201)
    expect((await owner.agent.get(`/documents/${anonymousDocument.body.id}`)).body.canDelete).toBe(true)

    const authenticatedDocument = await owner
      .unsafe('post', '/documents', registered.body.csrfToken)
      .expect(201)
    const loggedOut = await owner
      .unsafe('post', '/auth/logout', registered.body.csrfToken)
      .expect(200)
    expect((await owner.agent.get(`/documents/${anonymousDocument.body.id}`)).body.canDelete).toBe(false)
    const postLogoutAnonymousDocument = await owner
      .unsafe('post', '/documents', loggedOut.body.csrfToken)
      .expect(201)
    await owner
      .unsafe('delete', `/documents/${authenticatedDocument.body.id}`, loggedOut.body.csrfToken)
      .expect(403)

    const loggedIn = await owner
      .unsafe('post', '/auth/login', loggedOut.body.csrfToken)
      .send({ email: 'owner@example.com', password: 'correct horse battery' })
      .expect(200)
    await owner
      .unsafe('delete', `/documents/${authenticatedDocument.body.id}`, loggedIn.body.csrfToken)
      .expect(204)
    await owner
      .unsafe('delete', `/documents/${postLogoutAnonymousDocument.body.id}`, loggedIn.body.csrfToken)
      .expect(204)
  })

  it('returns ownership 403 before active 409 and allows only the owner after disconnect', async () => {
    const owner = await session(backend)
    const other = await session(backend)
    const created = await owner.unsafe('post', '/documents').expect(201)
    const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws/${created.body.id}`, {
      origin: ORIGIN,
    })
    await once(socket, 'open')

    await other.unsafe('delete', `/documents/${created.body.id}`)
      .expect(403)
      .expect({ error: 'Forbidden', code: 'DOCUMENT_FORBIDDEN' })
    await owner
      .unsafe('delete', `/documents/${created.body.id}`)
      .expect(409)
      .expect({ error: 'Document is active' })
    socket.close()
    await once(socket, 'close')
    await owner.unsafe('delete', `/documents/${created.body.id}`).expect(204)
  })

  it('rejects WebSocket origins exactly while preserving public Yjs and chat access', async () => {
    const owner = await session(backend)
    const created = await owner.unsafe('post', '/documents').expect(201)
    for (const path of [`/ws/${created.body.id}`, `/ws/chat/${created.body.id}`]) {
      const allowed = new WebSocket(baseUrl.replace('http:', 'ws:') + path, { origin: ORIGIN })
      await once(allowed, 'open')
      allowed.close()
      await once(allowed, 'close')

      for (const origin of [OTHER_ORIGIN, undefined]) {
        const denied = new WebSocket(baseUrl.replace('http:', 'ws:') + path, origin ? { origin } : undefined)
        const [, response] = (await once(denied, 'unexpected-response')) as [
          import('node:http').ClientRequest,
          import('node:http').IncomingMessage,
        ]
        expect(response.statusCode).toBe(403)
        response.resume()
      }
    }
  })
})
