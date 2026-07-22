import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createDatabase } from '../src/db/connection.js'
import { initializeSchema } from '../src/db/schema.js'
import { createCollaborationServer, type CollaborationServer } from '../src/server.js'

const DOCUMENT_ID = '00000000-0000-4000-8000-000000000001'
const FIXED_TIME = '2030-01-02T03:04:05.678Z'

const waitFor = async (condition: () => boolean | Promise<boolean>, timeout = 2_000) => {
  const deadline = Date.now() + timeout
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const nextMessage = async (socket: WebSocket): Promise<Record<string, unknown>> => {
  const [data, isBinary] = (await once(socket, 'message')) as [WebSocket.RawData, boolean]
  expect(isBinary).toBe(false)
  return JSON.parse(data.toString()) as Record<string, unknown>
}

const sendMessage = async (
  socket: WebSocket,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const received = nextMessage(socket)
  socket.send(JSON.stringify(message))
  return received
}

describe('chat schema', () => {
  it('creates an idempotent messages migration with the required FK, unique key and index', () => {
    const database = createDatabase(':memory:')
    initializeSchema(database)
    initializeSchema(database)

    expect(database.pragma('foreign_keys', { simple: true })).toBe(1)
    const foreignKeys = database.pragma('foreign_key_list(messages)') as Array<{
      table: string
      from: string
      to: string
      on_delete: string
    }>
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'documents',
          from: 'document_id',
          to: 'id',
          on_delete: 'CASCADE',
        }),
      ]),
    )

    const indexes = database.pragma('index_list(messages)') as Array<{ name: string; unique: number }>
    expect(indexes.some(({ unique }) => unique === 1)).toBe(true)
    expect(indexes.map(({ name }) => name)).toContain('messages_document_created_id_idx')

    database
      .prepare(
        'INSERT INTO documents (id, created_at, updated_at, title, state) VALUES (?, ?, ?, ?, ?)',
      )
      .run(DOCUMENT_ID, FIXED_TIME, FIXED_TIME, '', Buffer.from([0]))
    database
      .prepare(
        'INSERT INTO messages (id, document_id, client_message_id, author, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), DOCUMENT_ID, randomUUID(), 'Ana', 'Hola', FIXED_TIME)
    database.prepare('DELETE FROM documents WHERE id = ?').run(DOCUMENT_ID)
    expect(database.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
    expect(() =>
      database
        .prepare(
          'INSERT INTO messages (id, document_id, client_message_id, author, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), DOCUMENT_ID, randomUUID(), 'Ana', 'Huérfano', FIXED_TIME),
    ).toThrow()
    database.close()
  })
})

describe('chat backend', () => {
  let backend: CollaborationServer
  let baseUrl: string
  let wsBaseUrl: string
  let documentId: string
  const sockets = new Set<WebSocket>()

  const connectChat = async (id = documentId, options?: WebSocket.ClientOptions) => {
    const socket = new WebSocket(`${wsBaseUrl}/ws/chat/${id}`, options)
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    await once(socket, 'open')
    return socket
  }

  beforeEach(async () => {
    backend = createCollaborationServer({
      databasePath: ':memory:',
      now: () => new Date(FIXED_TIME),
    })
    backend.httpServer.listen(0, '127.0.0.1')
    await once(backend.httpServer, 'listening')
    const { port } = backend.httpServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
    wsBaseUrl = `ws://127.0.0.1:${port}`
    const created = await request(backend.app).post('/documents').expect(201)
    documentId = created.body.id
  })

  afterEach(async () => {
    for (const socket of sockets) socket.terminate()
    await backend.close()
  })

  it('dispatches exact chat upgrades without breaking Yjs and rejects invalid paths', async () => {
    const chat = await connectChat()
    expect(backend.activeChatRoomCount()).toBe(1)
    expect(backend.activeRoomCount()).toBe(0)

    const yjs = new WebSocket(`${wsBaseUrl}/ws/${documentId}`)
    sockets.add(yjs)
    const [data, isBinary] = (await once(yjs, 'message')) as [WebSocket.RawData, boolean]
    expect(isBinary).toBe(true)
    expect(data).toBeTruthy()
    expect(backend.activeRoomCount()).toBe(1)

    for (const path of ['/ws/chat/missing', `/ws/chat/${documentId}/extra`, '/ws/unknown/extra']) {
      const rejected = new WebSocket(wsBaseUrl + path)
      const [, response] = (await once(rejected, 'unexpected-response')) as [
        import('node:http').ClientRequest,
        import('node:http').IncomingMessage,
      ]
      expect(response.statusCode).toBe(404)
      response.resume()
    }

    const malformed = new WebSocket(`${wsBaseUrl}/ws/chat/%FF`)
    const [, malformedResponse] = (await once(malformed, 'unexpected-response')) as [
      import('node:http').ClientRequest,
      import('node:http').IncomingMessage,
    ]
    expect(malformedResponse.statusCode).toBe(400)
    malformedResponse.resume()
    chat.close()
    yjs.close()
  })

  it('persists before broadcasting a created message to every client', async () => {
    const first = await connectChat()
    const second = await connectChat()
    const clientMessageId = randomUUID()
    const firstEvent = nextMessage(first)
    const secondEvent = nextMessage(second)
    first.send(
      JSON.stringify({
        type: 'message:create',
        clientMessageId,
        author: '  Ana  ',
        content: '  Hola equipo  ',
      }),
    )

    const [forFirst, forSecond] = await Promise.all([firstEvent, secondEvent])
    expect(forFirst).toEqual(forSecond)
    expect(forFirst).toEqual({
      type: 'message:created',
      message: {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        documentId,
        clientMessageId,
        author: 'Ana',
        content: 'Hola equipo',
        createdAt: FIXED_TIME,
      },
    })
    await request(backend.app)
      .get(`/documents/${documentId}/messages`)
      .expect(200)
      .expect([forFirst.message])
  })

  it('returns history in ascending order with strict limit validation', async () => {
    const socket = await connectChat()
    const createdMessages: Array<Record<string, unknown>> = []
    for (let index = 0; index < 55; index += 1) {
      const response = await sendMessage(socket, {
        type: 'message:create',
        clientMessageId: randomUUID(),
        author: 'Ana',
        content: `Mensaje ${index}`,
      })
      createdMessages.push(response.message as Record<string, unknown>)
    }

    const expected = [...createdMessages].sort((left, right) =>
      String(left.id).localeCompare(String(right.id)),
    )
    await request(backend.app)
      .get(`/documents/${documentId}/messages`)
      .expect(200)
      .expect(expected.slice(-50))
    await request(backend.app)
      .get(`/documents/${documentId}/messages?limit=2`)
      .expect(200)
      .expect(expected.slice(-2))

    for (const limit of ['', '0', '51', '1.5', '01', '+1', ' 1', 'abc']) {
      await request(backend.app)
        .get(`/documents/${documentId}/messages?limit=${encodeURIComponent(limit)}`)
        .expect(400)
        .expect({ error: 'Invalid limit' })
    }
    await request(backend.app)
      .get('/documents/not-a-uuid/messages')
      .expect(404)
      .expect({ error: 'Document not found' })
    await request(backend.app)
      .get('/documents/00000000-0000-4000-8000-000000000099/messages')
      .expect(404)
      .expect({ error: 'Document not found' })
  })

  it('makes retries idempotent and reports conflicting reuse only to the sender', async () => {
    const first = await connectChat()
    const second = await connectChat()
    let peerMessageCount = 0
    second.on('message', () => {
      peerMessageCount += 1
    })
    const clientMessageId = randomUUID()
    const create = { type: 'message:create', clientMessageId, author: 'Ana', content: 'Hola' }
    const peerCreated = nextMessage(second)
    const created = await sendMessage(first, create)
    await peerCreated

    expect(await sendMessage(first, create)).toEqual(created)
    const conflict = await sendMessage(first, { ...create, content: 'Distinto' })
    expect(conflict).toEqual({
      type: 'error',
      code: 'CLIENT_MESSAGE_ID_CONFLICT',
      message: expect.any(String),
      clientMessageId,
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(peerMessageCount).toBe(1)
    await request(backend.app)
      .get(`/documents/${documentId}/messages`)
      .expect(200)
      .expect([created.message])
  })

  it('keeps the connection after recoverable business errors', async () => {
    const socket = await connectChat()
    const invalidCases = [
      [{ type: 'other' }, 'UNSUPPORTED_MESSAGE_TYPE'],
      [{ type: 'message:create', clientMessageId: 'bad', author: 'Ana', content: 'Hola' }, 'INVALID_MESSAGE'],
      [{ type: 'message:create', clientMessageId: randomUUID(), author: '   ', content: 'Hola' }, 'INVALID_MESSAGE'],
      [{ type: 'message:create', clientMessageId: randomUUID(), author: 'a'.repeat(41), content: 'Hola' }, 'INVALID_MESSAGE'],
      [{ type: 'message:create', clientMessageId: randomUUID(), author: 'Ana', content: '   ' }, 'INVALID_MESSAGE'],
      [{ type: 'message:create', clientMessageId: randomUUID(), author: 'Ana', content: 'a'.repeat(1001) }, 'INVALID_MESSAGE'],
    ] as const

    for (const [message, code] of invalidCases) {
      const response = await sendMessage(socket, message)
      expect(response).toMatchObject({ type: 'error', code, message: expect.any(String) })
      expect(socket.readyState).toBe(WebSocket.OPEN)
    }

    const created = await sendMessage(socket, {
      type: 'message:create',
      clientMessageId: randomUUID(),
      author: 'Ana',
      content: 'Sigue abierta',
    })
    expect(created.type).toBe('message:created')
  })

  it('closes invalid JSON with 1007 and binary frames with 1003', async () => {
    const invalidJson = await connectChat()
    invalidJson.send('{')
    const [invalidJsonCode] = (await once(invalidJson, 'close')) as [number, Buffer]
    expect(invalidJsonCode).toBe(1007)

    const binary = await connectChat()
    binary.send(Buffer.from([1, 2, 3]))
    const [binaryCode] = (await once(binary, 'close')) as [number, Buffer]
    expect(binaryCode).toBe(1003)
  })

  it('closes oversized text payloads with 1009 without persisting or broadcasting them', async () => {
    const sender = await connectChat()
    const peer = await connectChat()
    const peerMessages: WebSocket.RawData[] = []
    peer.on('message', (data) => peerMessages.push(data))

    sender.send(
      JSON.stringify({
        type: 'message:create',
        clientMessageId: randomUUID(),
        author: 'Ana',
        content: 'a'.repeat(17 * 1024),
      }),
    )

    const [closeCode] = (await once(sender, 'close')) as [number, Buffer]
    expect(closeCode).toBe(1009)
    expect(peerMessages).toEqual([])
    await request(backend.app).get(`/documents/${documentId}/messages`).expect(200).expect([])
  })

  it('blocks deletion only while chat clients remain and cascades their messages', async () => {
    const socket = await connectChat()
    await sendMessage(socket, {
      type: 'message:create',
      clientMessageId: randomUUID(),
      author: 'Ana',
      content: 'Temporal',
    })
    await request(backend.app)
      .delete(`/documents/${documentId}`)
      .expect(409)
      .expect({ error: 'Document is active' })

    socket.close()
    await once(socket, 'close')
    await waitFor(() => backend.activeChatRoomCount() === 0)
    await request(backend.app).delete(`/documents/${documentId}`).expect(204)
  })

  it('heartbeats chat clients and closes idempotently with active sockets', async () => {
    await backend.close()
    backend = createCollaborationServer({
      databasePath: ':memory:',
      heartbeatIntervalMs: 10,
      now: () => new Date(FIXED_TIME),
    })
    backend.httpServer.listen(0, '127.0.0.1')
    await once(backend.httpServer, 'listening')
    const { port } = backend.httpServer.address() as AddressInfo
    wsBaseUrl = `ws://127.0.0.1:${port}`
    const created = await request(backend.app).post('/documents').expect(201)
    documentId = created.body.id
    const socket = await connectChat(documentId, { autoPong: false })

    await once(socket, 'close')
    await waitFor(() => backend.activeChatRoomCount() === 0)
    const activeSocket = await connectChat()
    expect(backend.activeChatRoomCount()).toBe(1)
    const activeSocketClosed = once(activeSocket, 'close')
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined
    const shutdown = Promise.all([backend.close(), backend.close()]).then(() => 'closed' as const)
    const result = await Promise.race([
      shutdown,
      new Promise<'timed-out'>((resolve) => {
        shutdownTimer = setTimeout(() => resolve('timed-out'), 1_000)
      }),
    ]).finally(() => clearTimeout(shutdownTimer))
    expect(result).toBe('closed')
    await activeSocketClosed
    expect(activeSocket.readyState).toBe(WebSocket.CLOSED)
  })
})

describe('chat persistence on disk', () => {
  it('keeps messages durable across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chat-backend-'))
    const databasePath = join(directory, 'documents.sqlite')
    let backend = createCollaborationServer({ databasePath, now: () => new Date(FIXED_TIME) })
    try {
      backend.httpServer.listen(0, '127.0.0.1')
      await once(backend.httpServer, 'listening')
      const { port } = backend.httpServer.address() as AddressInfo
      const created = await request(backend.app).post('/documents').expect(201)
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/${created.body.id}`)
      await once(socket, 'open')
      await sendMessage(socket, {
        type: 'message:create',
        clientMessageId: randomUUID(),
        author: 'Ana',
        content: 'Persistido',
      })
      socket.close()
      await once(socket, 'close')
      await backend.close()

      backend = createCollaborationServer({ databasePath })
      const history = await request(backend.app)
        .get(`/documents/${created.body.id}/messages`)
        .expect(200)
      expect(history.body).toHaveLength(1)
      expect(history.body[0]).toMatchObject({ author: 'Ana', content: 'Persistido' })
    } finally {
      await backend.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
