import type { Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { DOCUMENT_TEXT, TIPTAP_FRAGMENT, UUID_PATTERN } from '../constants.js'
import type { DocumentRepository } from '../db/document-repository.js'

// The standard Yjs WebSocket envelope uses prefix 0 to route frames to y-protocols/sync.
const MESSAGE_SYNC = 0

interface Room {
  doc: Y.Doc
  clients: Set<WebSocket>
  dirty: boolean
}

export interface CollaborationWebSocket {
  activeRoomCount: () => number
  getActiveDocument: (documentId: string) => Y.Doc | undefined
  isDocumentActive: (documentId: string) => boolean
  close: () => Promise<void>
}

const sendHttpError = (socket: Duplex, status: number, message: string) => {
  const body = JSON.stringify({ error: message })
  socket.end(
    `HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : 'Bad Request'}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  )
}

const toUint8Array = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  return new Uint8Array(data)
}

export const createCollaborationWebSocket = (
  httpServer: HttpServer,
  repository: DocumentRepository,
  options: { now: () => Date; heartbeatIntervalMs: number },
): CollaborationWebSocket => {
  const rooms = new Map<string, Room>()
  const webSocketServer = new WebSocketServer({ noServer: true })
  const aliveClients = new WeakSet<WebSocket>()
  let closePromise: Promise<void> | undefined

  const heartbeatInterval = setInterval(() => {
    for (const client of webSocketServer.clients) {
      if (!aliveClients.has(client)) {
        client.terminate()
        continue
      }

      aliveClients.delete(client)
      if (client.readyState === WebSocket.OPEN) client.ping()
    }
  }, options.heartbeatIntervalMs)
  heartbeatInterval.unref()

  const persistAndDestroyRoom = (documentId: string, room: Room) => {
    if (rooms.get(documentId) !== room) return

    // Once a dirty room is empty, a full update is the durable snapshot needed to recreate its Y.Doc.
    if (room.dirty) {
      repository.saveState(
        documentId,
        Y.encodeStateAsUpdate(room.doc),
        options.now().toISOString(),
      )
    }
    rooms.delete(documentId)
    room.doc.destroy()
  }

  const getOrCreateRoom = (documentId: string): Room => {
    const activeRoom = rooms.get(documentId)
    if (activeRoom) return activeRoom

    const stored = repository.get(documentId)
    if (!stored) throw new Error('Cannot open a room for a missing document')

    // A single Y.Doc per active room is the in-memory source of truth shared by all its clients.
    const doc = new Y.Doc()
    doc.getXmlFragment(TIPTAP_FRAGMENT)
    doc.getText(DOCUMENT_TEXT)
    Y.applyUpdate(doc, stored.state)
    const room: Room = { doc, clients: new Set(), dirty: false }

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      room.dirty = true
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      const message = encoding.toUint8Array(encoder)

      for (const client of room.clients) {
        if (client !== origin && client.readyState === WebSocket.OPEN) client.send(message)
      }
    })

    rooms.set(documentId, room)
    return room
  }

  const connectToRoom = (socket: WebSocket, documentId: string) => {
    const room = getOrCreateRoom(documentId)
    room.clients.add(socket)
    aliveClients.add(socket)
    socket.on('pong', () => aliveClients.add(socket))

    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, room.doc)
    socket.send(encoding.toUint8Array(encoder))

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) {
        socket.close(1003, 'Binary messages required')
        return
      }

      try {
        const decoder = decoding.createDecoder(toUint8Array(data))
        if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return

        const response = encoding.createEncoder()
        encoding.writeVarUint(response, MESSAGE_SYNC)
        syncProtocol.readSyncMessage(decoder, response, room.doc, socket)
        if (encoding.length(response) > 1 && socket.readyState === WebSocket.OPEN) {
          socket.send(encoding.toUint8Array(response))
        }
      } catch {
        socket.close(1002, 'Invalid sync message')
      }
    })

    socket.on('close', () => {
      room.clients.delete(socket)
      if (room.clients.size === 0) persistAndDestroyRoom(documentId, room)
    })
  }

  httpServer.on('upgrade', (request, socket, head) => {
    let documentId: string | undefined
    try {
      const pathname = new URL(request.url ?? '', 'http://localhost').pathname
      const match = /^\/ws\/([^/]+)$/.exec(pathname)
      if (match) documentId = decodeURIComponent(match[1])
    } catch {
      sendHttpError(socket, 400, 'Bad request')
      return
    }

    if (!documentId || !UUID_PATTERN.test(documentId) || !repository.get(documentId)) {
      sendHttpError(socket, 404, 'Document not found')
      return
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      connectToRoom(webSocket, documentId)
    })
  })

  return {
    activeRoomCount: () => rooms.size,
    getActiveDocument: (documentId) => rooms.get(documentId)?.doc,
    isDocumentActive: (documentId) => rooms.has(documentId),
    close: () => {
      closePromise ??= (async () => {
        clearInterval(heartbeatInterval)
        for (const client of webSocketServer.clients) client.terminate()
        await new Promise<void>((resolve, reject) => {
          webSocketServer.close((error) => (error ? reject(error) : resolve()))
        })

        for (const [documentId, room] of rooms) persistAndDestroyRoom(documentId, room)
      })()
      return closePromise
    },
  }
}
