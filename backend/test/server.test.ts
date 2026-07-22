import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import WebSocket from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { createCollaborationServer, type CollaborationServer } from '../src/server.js'

const MESSAGE_SYNC = 0

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
      .expect([{ id: created.body.id, createdAt: created.body.createdAt, title: '' }])

    await request(backend.app)
      .get(`/documents/${created.body.id}`)
      .expect(200)
      .expect({ id: created.body.id, content: '', createdAt: created.body.createdAt })
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
      .expect({ id: body.id, content: 'contenido persistido', createdAt: body.createdAt })

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
        .expect({ id: body.id, content: 'persistido durante shutdown', createdAt: body.createdAt })
    } finally {
      client?.socket.terminate()
      await backend.close()
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })
})
