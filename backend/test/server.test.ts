import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import request from 'supertest'
import WebSocket from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { initializeSchema } from '../src/db/schema.js'
import { createCollaborationServer, type CollaborationServer } from '../src/server.js'

const MESSAGE_SYNC = 0
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const waitFor = async (condition: () => boolean | Promise<boolean>, timeout = 2_000) => {
  const deadline = Date.now() + timeout
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const connectYClient = async (url: string) => {
  const doc = new Y.Doc()
  const socket = new WebSocket(url)

  socket.on('message', (data) => {
    const decoder = decoding.createDecoder(new Uint8Array(data as Buffer))
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return

    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.readSyncMessage(decoder, encoder, doc, socket)
    if (encoding.length(encoder) > 1 && socket.readyState === WebSocket.OPEN) {
      socket.send(encoding.toUint8Array(encoder))
    }
  })

  doc.on('update', (update, origin) => {
    if (origin === socket || socket.readyState !== WebSocket.OPEN) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    socket.send(encoding.toUint8Array(encoder))
  })

  await once(socket, 'open')
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(encoder, doc)
  socket.send(encoding.toUint8Array(encoder))

  return { doc, socket }
}

describe('database migration', () => {
  it('adds updated_at to a legacy database, backfills it and remains idempotent', () => {
    const database = new Database(':memory:')
    const createdAt = '2025-01-02T03:04:05.678Z'
    database.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        state BLOB NOT NULL
      )
    `)
    database
      .prepare('INSERT INTO documents (id, created_at, title, state) VALUES (?, ?, ?, ?)')
      .run('legacy-document', createdAt, 'Legacy', Buffer.from([0]))

    initializeSchema(database)
    initializeSchema(database)

    const columns = database.pragma('table_info(documents)') as Array<{ name: string }>
    expect(columns.map(({ name }) => name)).toContain('updated_at')
    expect(database.prepare('SELECT updated_at FROM documents WHERE id = ?').get('legacy-document')).toEqual({
      updated_at: createdAt,
    })
    database.close()
  })
})

describe('collaboration backend', () => {
  let backend: CollaborationServer
  let baseUrl: string

  beforeEach(async () => {
    backend = createCollaborationServer({ databasePath: ':memory:' })
    backend.httpServer.listen(0, '127.0.0.1')
    await once(backend.httpServer, 'listening')
    const { port } = backend.httpServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await backend.close()
  })

  it('creates, lists and retrieves documents with the exact REST contract', async () => {
    const created = await request(backend.app).post('/documents').expect(201)

    expect(created.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      createdAt: expect.any(String),
    })

    await request(backend.app)
      .get('/documents')
      .expect(200)
      .expect([
        {
          id: created.body.id,
          createdAt: created.body.createdAt,
          title: '',
          updatedAt: created.body.createdAt,
        },
      ])

    await request(backend.app)
      .get(`/documents/${created.body.id}`)
      .expect(200)
      .expect({
        id: created.body.id,
        title: '',
        content: '',
        createdAt: created.body.createdAt,
        updatedAt: created.body.createdAt,
      })
  })

  it('trims and persists titles, including empty and 100-character values', async () => {
    const { body: created } = await request(backend.app).post('/documents').expect(201)

    const titled = await request(backend.app)
      .patch(`/documents/${created.id}`)
      .send({ title: '  Documento compartido  ' })
      .expect(200)
    expect(titled.body).toEqual({
      id: created.id,
      title: 'Documento compartido',
      createdAt: created.createdAt,
      updatedAt: expect.stringMatching(ISO_TIMESTAMP),
    })

    await request(backend.app)
      .get(`/documents/${created.id}`)
      .expect(200)
      .expect({ ...titled.body, content: '' })
    await request(backend.app)
      .get('/documents')
      .expect(200)
      .expect([{ ...titled.body }])

    await request(backend.app)
      .patch(`/documents/${created.id}`)
      .send({ title: '   ' })
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({
          id: created.id,
          title: '',
          createdAt: created.createdAt,
          updatedAt: expect.stringMatching(ISO_TIMESTAMP),
        })
      })
    await request(backend.app)
      .patch(`/documents/${created.id}`)
      .send({ title: ` ${'a'.repeat(100)} ` })
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({
          id: created.id,
          title: 'a'.repeat(100),
          createdAt: created.createdAt,
          updatedAt: expect.stringMatching(ISO_TIMESTAMP),
        })
      })
  })

  it.each([
    ['missing title', {}],
    ['non-string title', { title: 42 }],
    ['title longer than 100 characters after trim', { title: ` ${'a'.repeat(101)} ` }],
  ])('rejects an invalid title: %s', async (_case, body) => {
    const { body: created } = await request(backend.app).post('/documents').expect(201)
    await request(backend.app)
      .patch(`/documents/${created.id}`)
      .send(body)
      .expect(400)
      .expect({ error: 'Invalid title' })
  })

  it('returns 404 when patching a missing or invalid document id', async () => {
    await request(backend.app)
      .patch('/documents/missing')
      .send({ title: 'Título' })
      .expect(404)
      .expect({ error: 'Document not found' })
    await request(backend.app)
      .patch('/documents/00000000-0000-4000-8000-000000000000')
      .send({ title: 'Título' })
      .expect(404)
      .expect({ error: 'Document not found' })
  })

  it('returns JSON 404 responses for missing documents and routes', async () => {
    await request(backend.app).get('/documents/missing').expect(404).expect({ error: 'Document not found' })
    await request(backend.app).get('/unknown').expect(404).expect({ error: 'Not found' })
  })

  it('rejects a websocket upgrade for a document that does not exist', async () => {
    const url = baseUrl.replace('http:', 'ws:') + '/ws/missing'
    const socket = new WebSocket(url)
    const [, response] = (await once(socket, 'unexpected-response')) as [
      import('node:http').ClientRequest,
      import('node:http').IncomingMessage,
    ]
    expect(response.statusCode).toBe(404)
    response.resume()
  })

  it('synchronizes standard y-protocols binary messages between two clients', async () => {
    const { body } = await request(backend.app).post('/documents').expect(201)
    const wsUrl = baseUrl.replace('http:', 'ws:') + `/ws/${body.id}`
    const first = await connectYClient(wsUrl)
    const second = await connectYClient(wsUrl)

    first.doc.getText('document-content').insert(0, 'hola colaborativa')
    await waitFor(() => second.doc.getText('document-content').toString() === 'hola colaborativa')

    first.socket.close()
    second.socket.close()
    await Promise.all([once(first.socket, 'close'), once(second.socket, 'close')])
  })

  it('returns synchronized Tiptap content from the default XML fragment', async () => {
    const { body } = await request(backend.app).post('/documents').expect(201)
    const client = await connectYClient(baseUrl.replace('http:', 'ws:') + `/ws/${body.id}`)
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.insert(0, [new Y.XmlText('contenido Tiptap')])

    client.doc.getXmlFragment('default').insert(0, [paragraph])
    await waitFor(async () => {
      const response = await request(backend.app).get(`/documents/${body.id}`)
      return response.body.content === '<paragraph>contenido Tiptap</paragraph>'
    })

    client.socket.close()
    await once(client.socket, 'close')
  })

  it('does not change updatedAt when a room closes without document updates', async () => {
    await backend.close()
    backend = createCollaborationServer({
      databasePath: ':memory:',
      now: () => new Date('2030-01-02T03:04:05.678Z'),
    })
    backend.httpServer.listen(0, '127.0.0.1')
    await once(backend.httpServer, 'listening')
    const { port } = backend.httpServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
    const { body } = await request(backend.app).post('/documents').expect(201)
    const client = await connectYClient(baseUrl.replace('http:', 'ws:') + `/ws/${body.id}`)

    client.socket.close()
    await once(client.socket, 'close')
    await waitFor(() => backend.activeRoomCount() === 0)

    const detail = await request(backend.app).get(`/documents/${body.id}`).expect(200)
    expect(detail.body.updatedAt).toBe(body.createdAt)
  })

  it('persists document updates with the controlled room timestamp', async () => {
    const persistedAt = '2030-01-02T03:04:05.678Z'
    await backend.close()
    backend = createCollaborationServer({ databasePath: ':memory:', now: () => new Date(persistedAt) })
    backend.httpServer.listen(0, '127.0.0.1')
    await once(backend.httpServer, 'listening')
    const { port } = backend.httpServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
    const { body } = await request(backend.app).post('/documents').expect(201)
    const client = await connectYClient(baseUrl.replace('http:', 'ws:') + `/ws/${body.id}`)

    client.doc.getText('document-content').insert(0, 'edición controlada')
    client.socket.close()
    await once(client.socket, 'close')
    await waitFor(() => backend.activeRoomCount() === 0)

    const detail = await request(backend.app).get(`/documents/${body.id}`).expect(200)
    expect(detail.body.updatedAt).toBe(persistedAt)
  })

  it('terminates clients that do not answer heartbeat pings', async () => {
    await backend.close()
    backend = createCollaborationServer({ databasePath: ':memory:', heartbeatIntervalMs: 10 })
    backend.httpServer.listen(0, '127.0.0.1')
    await once(backend.httpServer, 'listening')
    const { port } = backend.httpServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
    const { body } = await request(backend.app).post('/documents').expect(201)
    const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + `/ws/${body.id}`, {
      autoPong: false,
    })
    await once(socket, 'open')

    await once(socket, 'close')
    await waitFor(() => backend.activeRoomCount() === 0)
  })

  it('keeps clients alive when they answer heartbeat pings', async () => {
    await backend.close()
    backend = createCollaborationServer({ databasePath: ':memory:', heartbeatIntervalMs: 10 })
    backend.httpServer.listen(0, '127.0.0.1')
    await once(backend.httpServer, 'listening')
    const { port } = backend.httpServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
    const { body } = await request(backend.app).post('/documents').expect(201)
    const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + `/ws/${body.id}`)
    await once(socket, 'open')
    await once(socket, 'ping')
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
    await once(socket, 'close')
  })

  it('persists a room when its last client leaves and reloads it on reconnect', async () => {
    const { body } = await request(backend.app).post('/documents').expect(201)
    const wsUrl = baseUrl.replace('http:', 'ws:') + `/ws/${body.id}`
    const first = await connectYClient(wsUrl)

    first.doc.getText('document-content').insert(0, 'contenido persistido')
    first.socket.close()
    await once(first.socket, 'close')
    await waitFor(() => backend.activeRoomCount() === 0)

    await request(backend.app)
      .get(`/documents/${body.id}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({
          id: body.id,
          title: '',
          content: 'contenido persistido',
          createdAt: body.createdAt,
          updatedAt: expect.stringMatching(ISO_TIMESTAMP),
        })
        expect(Date.parse(response.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(body.createdAt))
      })

    const reopened = await connectYClient(wsUrl)
    await waitFor(() => reopened.doc.getText('document-content').toString() === 'contenido persistido')
    reopened.socket.close()
    await once(reopened.socket, 'close')
  })

  it('shuts down promptly with a connected client and persists its document', async () => {
    await backend.close()
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'collaboration-backend-'))
    const databasePath = join(temporaryDirectory, 'documents.sqlite')
    backend = createCollaborationServer({ databasePath })
    backend.httpServer.listen(0, '127.0.0.1')
    await once(backend.httpServer, 'listening')
    const { port } = backend.httpServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`

    let client: Awaited<ReturnType<typeof connectYClient>> | undefined
    try {
      const { body } = await request(backend.app).post('/documents').expect(201)
      client = await connectYClient(baseUrl.replace('http:', 'ws:') + `/ws/${body.id}`)
      client.doc.getText('document-content').insert(0, 'persistido durante shutdown')
      await waitFor(async () => {
        const response = await request(backend.app).get(`/documents/${body.id}`)
        return response.body.content === 'persistido durante shutdown'
      })

      let shutdownTimer: ReturnType<typeof setTimeout> | undefined
      const shutdownResult = await Promise.race([
        backend.close().then(() => 'closed' as const),
        new Promise<'timed-out'>((resolve) => {
          shutdownTimer = setTimeout(() => resolve('timed-out'), 1_000)
        }),
      ]).finally(() => clearTimeout(shutdownTimer))
      expect(shutdownResult).toBe('closed')

      backend = createCollaborationServer({ databasePath })
      await request(backend.app)
        .get(`/documents/${body.id}`)
        .expect(200)
        .expect((response) => {
          expect(response.body).toEqual({
            id: body.id,
            title: '',
            content: 'persistido durante shutdown',
            createdAt: body.createdAt,
            updatedAt: expect.stringMatching(ISO_TIMESTAMP),
          })
          expect(Date.parse(response.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(body.createdAt))
        })
    } finally {
      client?.socket.terminate()
      await backend.close()
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('deletes inactive documents and returns 404 for missing or invalid ids', async () => {
    const { body: created } = await request(backend.app).post('/documents').expect(201)

    await request(backend.app).delete(`/documents/${created.id}`).expect(204).expect('')
    await request(backend.app)
      .delete(`/documents/${created.id}`)
      .expect(404)
      .expect({ error: 'Document not found' })
    await request(backend.app)
      .delete('/documents/not-a-uuid')
      .expect(404)
      .expect({ error: 'Document not found' })
  })

  it('rejects deletion while a room is active and allows it after the last disconnect', async () => {
    const { body: created } = await request(backend.app).post('/documents').expect(201)
    const client = await connectYClient(baseUrl.replace('http:', 'ws:') + `/ws/${created.id}`)

    await request(backend.app)
      .delete(`/documents/${created.id}`)
      .expect(409)
      .expect({ error: 'Document is active' })

    client.socket.close()
    await once(client.socket, 'close')
    await waitFor(() => backend.activeRoomCount() === 0)
    await request(backend.app).delete(`/documents/${created.id}`).expect(204).expect('')
  })
})
