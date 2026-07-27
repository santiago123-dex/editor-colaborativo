import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { createCollaborationServer, type CollaborationServer } from '../src/server.js'
import { SqliteDocumentRepository } from '../src/db/document-repository.js'

const ORIGIN = 'http://localhost:5173'
const MESSAGE_DURABILITY = 4
const VERSION = 1
const FLUSH_REQUEST = 0
const DURABLE = 1
const PERSISTENCE_ERROR = 2
const DURABILITY_RESPONSE_CACHE_LIMIT = 256

class OriginWebSocket extends WebSocket {
  constructor(address: string | URL, protocols?: string | string[]) {
    super(address, protocols, { origin: ORIGIN })
  }
}

class NoPongWebSocket extends WebSocket {
  constructor(address: string | URL, protocols?: string | string[]) {
    super(address, protocols, { origin: ORIGIN, autoPong: false })
  }
}

const waitFor = async (condition: () => boolean | Promise<boolean>, timeout = 2_000) => {
  const deadline = Date.now() + timeout
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const flushFrame = (requestId: Uint8Array, stateVector: Uint8Array = new Uint8Array()): Uint8Array => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_DURABILITY)
  encoding.writeVarUint(encoder, VERSION)
  encoding.writeVarUint(encoder, FLUSH_REQUEST)
  encoding.writeVarUint8Array(encoder, requestId)
  encoding.writeVarUint8Array(encoder, stateVector)
  return encoding.toUint8Array(encoder)
}

const nextBinaryMessage = (socket: WebSocket): Promise<Uint8Array> =>
  new Promise((resolve) => socket.once('message', (data) => resolve(new Uint8Array(data as Buffer))))

const awarenessFrame = (updates: Array<{ clientId: number; clock: number; state: unknown }>): Uint8Array => {
  const update = encoding.createEncoder()
  encoding.writeVarUint(update, updates.length)
  for (const { clientId, clock, state } of updates) {
    encoding.writeVarUint(update, clientId)
    encoding.writeVarUint(update, clock)
    encoding.writeVarString(update, JSON.stringify(state))
  }
  const frame = encoding.createEncoder()
  encoding.writeVarUint(frame, 1)
  encoding.writeVarUint8Array(frame, encoding.toUint8Array(update))
  return encoding.toUint8Array(frame)
}

const waitForSync = (provider: WebsocketProvider): Promise<void> => {
  if (provider.synced) return Promise.resolve()
  return new Promise((resolve) => {
    const onSync = (synced: boolean) => {
      if (!synced) return
      provider.off('sync', onSync)
      resolve()
    }
    provider.on('sync', onSync)
  })
}

describe('incremental collaboration, durable ACK and awareness', () => {
  let backend: CollaborationServer
  let directory: string
  let databasePath: string
  let baseUrl: string
  let api: ReturnType<typeof request.agent>

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'collaboration-features-'))
    databasePath = join(directory, 'database.sqlite')
    backend = createCollaborationServer({
      databasePath,
      persistenceDebounceMs: 30,
      persistenceMaxWaitMs: 100,
      heartbeatIntervalMs: 5_000,
      allowedOrigins: [ORIGIN],
    })
    api = request.agent(backend.app)
    const session = await api.get('/auth/session').expect(200)
    api = api.set('Origin', ORIGIN).set('X-CSRF-Token', session.body.csrfToken)
    backend.httpServer.listen(0, '127.0.0.1')
    await once(backend.httpServer, 'listening')
    const { port } = backend.httpServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await backend.close()
    await rm(directory, { recursive: true, force: true })
  })

  const createDocument = async () => (await api.post('/documents').expect(201)).body as { id: string; createdAt: string }

  const provider = (id: string, WebSocketPolyfill: typeof OriginWebSocket = OriginWebSocket) => {
    const doc = new Y.Doc()
    const instance = new WebsocketProvider(baseUrl.replace('http:', 'ws:') + '/ws', id, doc, {
      WebSocketPolyfill: WebSocketPolyfill as unknown as typeof globalThis.WebSocket,
      disableBc: true,
    })
    // This test client opts into type 4 and consumes the response outside y-websocket.
    instance.messageHandlers[MESSAGE_DURABILITY] = () => {}
    return { doc, provider: instance }
  }

  it('debounces multiple updates into one durable batch while broadcasting immediately', async () => {
    const document = await createDocument()
    const first = provider(document.id)
    const second = provider(document.id)
    await Promise.all([waitForSync(first.provider), waitForSync(second.provider)])

    first.doc.getText('document-content').insert(0, 'a')
    first.doc.getText('document-content').insert(1, 'b')
    await waitFor(() => second.doc.getText('document-content').toString() === 'ab')

    const reader = new Database(databasePath, { readonly: true })
    await waitFor(() => reader.prepare('SELECT count(*) FROM document_updates').pluck().get() === 1)
    expect(reader.prepare('SELECT y_revision FROM documents WHERE id = ?').pluck().get(document.id)).toBe(1)
    reader.close()
    first.provider.destroy()
    second.provider.destroy()
  })

  it('flushes by maxWait under continuous edits', async () => {
    const document = await createDocument()
    const client = provider(document.id)
    await waitForSync(client.provider)
    const reader = new Database(databasePath, { readonly: true })
    for (let index = 0; index < 6; index += 1) {
      client.doc.getText('document-content').insert(index, 'x')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await waitFor(() => Number(reader.prepare('SELECT y_revision FROM documents WHERE id = ?').pluck().get(document.id)) >= 1)
    reader.close()
    client.provider.destroy()
  })

  it('recovers an inactive effective state from a real file-backed update log after restart', async () => {
    const document = await createDocument()
    const source = new Y.Doc()
    source.getText('document-content').insert(0, 'log recovered')
    const external = new Database(databasePath)
    new SqliteDocumentRepository(external).appendUpdates(
      document.id,
      [Y.encodeStateAsUpdate(source)],
      '2026-07-22T12:00:00.000Z',
    )
    external.close()

    await api.get(`/documents/${document.id}`).expect(200).expect((response) => {
      expect(response.body.content).toBe('log recovered')
      expect(response.body.updatedAt).toBe('2026-07-22T12:00:00.000Z')
    })
    await backend.close()
    backend = createCollaborationServer({ databasePath, allowedOrigins: [ORIGIN] })
    await request(backend.app).get(`/documents/${document.id}`).expect(200).expect((response) => {
      expect(response.body.content).toBe('log recovered')
    })
  })

  it('returns opt-in DURABLE only after commit and deduplicates requestId per socket', async () => {
    const document = await createDocument()
    const client = provider(document.id)
    await waitForSync(client.provider)
    client.doc.getText('document-content').insert(0, 'durable')
    const socket = client.provider.ws as unknown as WebSocket
    const requestId = new Uint8Array(randomBytes(16))
    const frame = flushFrame(requestId, new Uint8Array(Y.encodeStateVector(client.doc)))

    const firstResponsePromise = nextBinaryMessage(socket)
    socket.send(frame)
    const firstResponse = await firstResponsePromise
    const decoder = decoding.createDecoder(firstResponse)
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_DURABILITY)
    expect(decoding.readVarUint(decoder)).toBe(VERSION)
    expect(decoding.readVarUint(decoder)).toBe(DURABLE)
    expect(decoding.readVarUint8Array(decoder)).toEqual(requestId)
    expect(decoding.readVarString(decoder)).toBe('1')
    expect(decoding.readVarUint8Array(decoder)).toEqual(Y.encodeStateVector(client.doc))
    expect(decoding.readVarString(decoder)).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const duplicatePromise = nextBinaryMessage(socket)
    socket.send(frame)
    expect(await duplicatePromise).toEqual(firstResponse)
    const reader = new Database(databasePath, { readonly: true })
    expect(reader.prepare('SELECT count(*) FROM document_updates').pluck().get()).toBe(1)
    reader.close()
    client.provider.destroy()
  })

  it('rejects a future or foreign requested state vector after flushing without sending DURABLE', async () => {
    const document = await createDocument()
    const client = provider(document.id)
    await waitForSync(client.provider)
    const foreign = new Y.Doc()
    foreign.getText('document-content').insert(0, 'not on server')
    const requestId = new Uint8Array(randomBytes(16))
    const responsePromise = nextBinaryMessage(client.provider.ws as unknown as WebSocket)

    ;(client.provider.ws as unknown as WebSocket).send(flushFrame(requestId, Y.encodeStateVector(foreign)))

    const response = decoding.createDecoder(await responsePromise)
    expect(decoding.readVarUint(response)).toBe(MESSAGE_DURABILITY)
    expect(decoding.readVarUint(response)).toBe(VERSION)
    expect(decoding.readVarUint(response)).toBe(PERSISTENCE_ERROR)
    expect(decoding.readVarUint8Array(response)).toEqual(requestId)
    expect(decoding.readVarString(response)).toBe('STATE_NOT_AVAILABLE')
    expect(decoding.readVarUint(response)).toBe(0)
    client.provider.destroy()
  })

  it('treats a delete-only sync update before FLUSH_REQUEST as part of the durability barrier', async () => {
    const document = await createDocument()
    const client = provider(document.id)
    await waitForSync(client.provider)
    const text = client.doc.getText('document-content')
    text.insert(0, 'remove')
    const socket = client.provider.ws as unknown as WebSocket
    let responsePromise = nextBinaryMessage(socket)
    socket.send(flushFrame(new Uint8Array(randomBytes(16))))
    let response = decoding.createDecoder(await responsePromise)
    decoding.readVarUint(response)
    decoding.readVarUint(response)
    expect(decoding.readVarUint(response)).toBe(DURABLE)
    expect(decoding.readVarUint8Array(response).byteLength).toBe(16)
    expect(decoding.readVarString(response)).toBe('1')

    text.delete(0, text.length)
    responsePromise = nextBinaryMessage(socket)
    socket.send(flushFrame(new Uint8Array(randomBytes(16))))
    response = decoding.createDecoder(await responsePromise)
    decoding.readVarUint(response)
    decoding.readVarUint(response)
    expect(decoding.readVarUint(response)).toBe(DURABLE)
    expect(decoding.readVarUint8Array(response).byteLength).toBe(16)
    expect(decoding.readVarString(response)).toBe('2')
    await api.get(`/documents/${document.id}`).expect(200).expect((detail) => {
      expect(detail.body.content).toBe('')
    })
    client.provider.destroy()
  })

  it('does not send custom type 4 spontaneously and closes malformed requests with 1002', async () => {
    const document = await createDocument()
    const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + `/ws/${document.id}`, { origin: ORIGIN })
    const types: number[] = []
    socket.on('message', (data) => {
      const decoder = decoding.createDecoder(new Uint8Array(data as Buffer))
      types.push(decoding.readVarUint(decoder))
    })
    await once(socket, 'open')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(types).not.toContain(MESSAGE_DURABILITY)
    const invalid = encoding.createEncoder()
    encoding.writeVarUint(invalid, MESSAGE_DURABILITY)
    encoding.writeVarUint(invalid, 99)
    socket.send(encoding.toUint8Array(invalid))
    const [code] = await once(socket, 'close')
    expect(code).toBe(1002)
  })

  it('does not cache a persistence error and retries the same request after pending state becomes writable', async () => {
    const document = await createDocument()
    const client = provider(document.id)
    await waitForSync(client.provider)
    const blocker = new Database(databasePath)
    blocker.exec('BEGIN IMMEDIATE')
    client.doc.getText('document-content').insert(0, 'retained')
    const socket = client.provider.ws as unknown as WebSocket
    const firstRequestId = new Uint8Array(randomBytes(16))
    const failedPromise = nextBinaryMessage(socket)
    const frame = flushFrame(firstRequestId)
    socket.send(frame)
    const failed = decoding.createDecoder(await failedPromise)
    expect(decoding.readVarUint(failed)).toBe(MESSAGE_DURABILITY)
    expect(decoding.readVarUint(failed)).toBe(VERSION)
    expect(decoding.readVarUint(failed)).toBe(PERSISTENCE_ERROR)
    expect(decoding.readVarUint8Array(failed)).toEqual(firstRequestId)
    expect(decoding.readVarString(failed)).toBe('PERSISTENCE_UNAVAILABLE')
    expect(decoding.readVarUint(failed)).toBe(1)
    expect(backend.activeRoomCount()).toBe(1)

    blocker.exec('ROLLBACK')
    blocker.close()
    const retriedPromise = nextBinaryMessage(socket)
    socket.send(frame)
    const retried = decoding.createDecoder(await retriedPromise)
    expect(decoding.readVarUint(retried)).toBe(MESSAGE_DURABILITY)
    expect(decoding.readVarUint(retried)).toBe(VERSION)
    expect(decoding.readVarUint(retried)).toBe(DURABLE)
    client.provider.destroy()
  }, 5_000)

  it('bounds successful DURABLE response caching to 256 entries per socket', async () => {
    const document = await createDocument()
    const client = provider(document.id)
    await waitForSync(client.provider)
    const socket = client.provider.ws as unknown as WebSocket
    const requestIds = Array.from(
      { length: DURABILITY_RESPONSE_CACHE_LIMIT + 1 },
      () => new Uint8Array(randomBytes(16)),
    )
    for (const requestId of requestIds) {
      const responsePromise = nextBinaryMessage(socket)
      socket.send(flushFrame(requestId))
      await responsePromise
    }

    const blocker = new Database(databasePath)
    blocker.exec('BEGIN IMMEDIATE')
    client.doc.getText('document-content').insert(0, 'pending')
    const evictedPromise = nextBinaryMessage(socket)
    socket.send(flushFrame(requestIds[0]!))
    const evicted = decoding.createDecoder(await evictedPromise)
    decoding.readVarUint(evicted)
    decoding.readVarUint(evicted)
    expect(decoding.readVarUint(evicted)).toBe(PERSISTENCE_ERROR)

    const cachedPromise = nextBinaryMessage(socket)
    socket.send(flushFrame(requestIds.at(-1)!))
    const cached = decoding.createDecoder(await cachedPromise)
    decoding.readVarUint(cached)
    decoding.readVarUint(cached)
    expect(decoding.readVarUint(cached)).toBe(DURABLE)
    blocker.exec('ROLLBACK')
    blocker.close()
    client.provider.destroy()
  }, 10_000)

  it('shares standard awareness in a room, isolates rooms and cleans abrupt disconnects without persistence', async () => {
    const firstDocument = await createDocument()
    const secondDocument = await createDocument()
    const first = provider(firstDocument.id)
    const second = provider(firstDocument.id)
    const isolated = provider(secondDocument.id)
    await Promise.all([
      waitForSync(first.provider),
      waitForSync(second.provider),
      waitForSync(isolated.provider),
    ])

    first.provider.awareness.setLocalState({ user: { name: 'Santiago' } })
    await waitFor(() => second.provider.awareness.getStates().has(first.doc.clientID))
    expect(isolated.provider.awareness.getStates().has(first.doc.clientID)).toBe(false)

    const queryResponse = nextBinaryMessage(second.provider.ws as unknown as WebSocket)
    const query = encoding.createEncoder()
    encoding.writeVarUint(query, 3)
    ;(second.provider.ws as unknown as WebSocket).send(encoding.toUint8Array(query))
    const queryDecoder = decoding.createDecoder(await queryResponse)
    expect(decoding.readVarUint(queryDecoder)).toBe(1)
    expect(decoding.readVarUint8Array(queryDecoder).byteLength).toBeGreaterThan(0)

    ;(first.provider.ws as unknown as WebSocket).terminate()
    await waitFor(() => !second.provider.awareness.getStates().has(first.doc.clientID))
    const reader = new Database(databasePath, { readonly: true })
    expect(reader.prepare('SELECT count(*) FROM document_updates').pluck().get()).toBe(0)
    expect(reader.prepare('SELECT updated_at FROM documents WHERE id = ?').pluck().get(firstDocument.id)).toBe(firstDocument.createdAt)
    reader.close()
    first.provider.destroy()
    second.provider.destroy()
    isolated.provider.destroy()
  })

  it('rejects an atomic malicious awareness takeover without changing or removing victim state', async () => {
    const document = await createDocument()
    const victim = provider(document.id)
    const attacker = provider(document.id)
    await Promise.all([waitForSync(victim.provider), waitForSync(attacker.provider)])
    victim.provider.awareness.setLocalState({ user: { name: 'victim' } })
    await waitFor(() => attacker.provider.awareness.getStates().has(victim.doc.clientID))
    const victimMeta = victim.provider.awareness.meta.get(victim.doc.clientID)!
    const attackerSocket = attacker.provider.ws as unknown as WebSocket

    attackerSocket.send(awarenessFrame([
      { clientId: attacker.doc.clientID, clock: 1, state: { user: { name: 'attacker' } } },
      { clientId: victim.doc.clientID, clock: victimMeta.clock + 1, state: null },
    ]))
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(attackerSocket.readyState).toBe(WebSocket.OPEN)
    expect(victim.provider.awareness.getStates().get(victim.doc.clientID)).toEqual({ user: { name: 'victim' } })
    expect(victim.provider.awareness.getStates().has(attacker.doc.clientID)).toBe(false)
    victim.provider.destroy()
    attacker.provider.destroy()
  })

  it('rejects an overlapping connection that claims an awareness id already owned by another socket', async () => {
    const document = await createDocument()
    const victim = provider(document.id)
    const attacker = provider(document.id)
    await Promise.all([waitForSync(victim.provider), waitForSync(attacker.provider)])
    victim.provider.awareness.setLocalState({ user: { name: 'victim' } })
    await waitFor(() => attacker.provider.awareness.getStates().has(victim.doc.clientID))
    const victimMeta = victim.provider.awareness.meta.get(victim.doc.clientID)!
    const attackerSocket = attacker.provider.ws as unknown as WebSocket

    attackerSocket.send(awarenessFrame([
      { clientId: victim.doc.clientID, clock: victimMeta.clock + 1, state: { user: { name: 'takeover' } } },
    ]))
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(attackerSocket.readyState).toBe(WebSocket.OPEN)
    expect(victim.provider.awareness.getStates().get(victim.doc.clientID)).toEqual({ user: { name: 'victim' } })
    victim.provider.destroy()
    attacker.provider.destroy()
  })

  it('removes awareness controlled by a client terminated by heartbeat', async () => {
    await backend.close()
    backend = createCollaborationServer({
      databasePath,
      heartbeatIntervalMs: 30,
      persistenceDebounceMs: 30,
      persistenceMaxWaitMs: 100,
      allowedOrigins: [ORIGIN],
    })
    api = request.agent(backend.app)
    const session = await api.get('/auth/session').expect(200)
    api = api.set('Origin', ORIGIN).set('X-CSRF-Token', session.body.csrfToken)
    backend.httpServer.listen(0, '127.0.0.1')
    await once(backend.httpServer, 'listening')
    const { port } = backend.httpServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
    const document = await createDocument()
    const observer = provider(document.id)
    const abandoned = provider(document.id, NoPongWebSocket)
    await Promise.all([waitForSync(observer.provider), waitForSync(abandoned.provider)])
    abandoned.provider.awareness.setLocalState({ user: { name: 'abrupt' } })
    await waitFor(() => observer.provider.awareness.getStates().has(abandoned.doc.clientID))
    await waitFor(() => !observer.provider.awareness.getStates().has(abandoned.doc.clientID), 1_000)
    observer.provider.destroy()
    abandoned.provider.destroy()
  })

  it('retries failed shutdown components and closes the database only after every component succeeds', async () => {
    await backend.close()
    let chatCloseAttempts = 0
    backend = createCollaborationServer(
      {
        databasePath,
        persistenceDebounceMs: 30,
        persistenceMaxWaitMs: 100,
        heartbeatIntervalMs: 5_000,
        allowedOrigins: [ORIGIN],
      },
      {
        afterChatTransportClose: () => {
          chatCloseAttempts += 1
          if (chatCloseAttempts === 1) throw new Error('forced chat close failure')
        },
      },
    )
    api = request.agent(backend.app)
    const session = await api.get('/auth/session').expect(200)
    api = api.set('Origin', ORIGIN).set('X-CSRF-Token', session.body.csrfToken)
    backend.httpServer.listen(0, '127.0.0.1')
    await once(backend.httpServer, 'listening')
    const { port } = backend.httpServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
    const firstDocument = await createDocument()
    const secondDocument = await createDocument()
    const first = provider(firstDocument.id)
    const second = provider(secondDocument.id)
    await Promise.all([waitForSync(first.provider), waitForSync(second.provider)])
    first.doc.getText('document-content').insert(0, 'first pending')
    second.doc.getText('document-content').insert(0, 'second persisted')
    const chatSocket = new WebSocket(baseUrl.replace('http:', 'ws:') + `/ws/chat/${secondDocument.id}`, {
      origin: ORIGIN,
    })
    await once(chatSocket, 'open')

    const chatClosed = once(chatSocket, 'close')
    const httpClosed = once(backend.httpServer, 'close')

    const firstClose = backend.close()
    const concurrentClose = backend.close()
    expect(concurrentClose).toBe(firstClose)
    await expect(firstClose).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'forced chat close failure' })],
    })
    await Promise.all([chatClosed, httpClosed])

    await api.get(`/documents/${firstDocument.id}`).expect(200)
    const inspector = new Database(databasePath)
    expect(inspector.prepare('SELECT y_revision FROM documents WHERE id = ?').pluck().get(firstDocument.id)).toBe(1)
    expect(inspector.prepare('SELECT y_revision FROM documents WHERE id = ?').pluck().get(secondDocument.id)).toBe(1)
    expect(backend.activeRoomCount()).toBe(0)
    expect(backend.activeChatRoomCount()).toBe(1)
    expect(backend.httpServer.listening).toBe(false)
    inspector.close()

    await expect(backend.close()).resolves.toBeUndefined()
    expect(backend.activeRoomCount()).toBe(0)
    expect(backend.activeChatRoomCount()).toBe(0)
    expect(chatCloseAttempts).toBe(2)
    const persisted = new Database(databasePath, { readonly: true })
    const repository = new SqliteDocumentRepository(persisted)
    const restored = new Y.Doc()
    Y.applyUpdate(restored, repository.get(firstDocument.id)!.state)
    expect(restored.getText('document-content').toString()).toBe('first pending')
    persisted.close()
    first.provider.destroy()
    second.provider.destroy()
  }, 10_000)
})
