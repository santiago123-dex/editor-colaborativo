import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import * as syncProtocol from 'y-protocols/sync'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness.js'
import * as Y from 'yjs'
import { DOCUMENT_TEXT, TIPTAP_FRAGMENT } from '../constants.js'
import type { DocumentRepository } from '../db/document-repository.js'
import {
  DURABILITY_RESPONSE_CACHE_LIMIT,
  DURABILITY_VERSION,
  DURABLE,
  FLUSH_REQUEST,
  MESSAGE_DURABILITY,
  PERSISTENCE_ERROR,
  writeDurable,
  writePersistenceError,
} from './durability-protocol.js'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_AWARENESS_QUERY = 3

interface Room {
  doc: Y.Doc
  clients: Set<WebSocket>
  dirty: boolean
  pendingUpdates: Uint8Array[]
  revision: number
  awareness: Awareness
  ownership: Map<number, WebSocket>
  socketToClientId: WeakMap<WebSocket, number>
  debounceTimer?: ReturnType<typeof setTimeout>
  maxWaitTimer?: ReturnType<typeof setTimeout>
}

export interface CollaborationWebSocket {
  activeRoomCount: () => number
  getActiveDocument: (documentId: string) => Y.Doc | undefined
  isDocumentActive: (documentId: string) => boolean
  handleUpgrade: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    documentId: string,
  ) => void
  close: () => Promise<void>
}

const toUint8Array = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  return new Uint8Array(data)
}

const stateVectorsEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const encodeAwarenessMessage = (body: Uint8Array): Uint8Array => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 1)
  encoding.writeVarUint8Array(encoder, body)
  return encoding.toUint8Array(encoder)
}

const mergeUpdates = (updates: Uint8Array[]): Uint8Array => {
  const tempDoc = new Y.Doc()
  for (const update of updates) Y.applyUpdate(tempDoc, update)
  const merged = Y.encodeStateAsUpdate(tempDoc)
  tempDoc.destroy()
  return merged
}

export const createCollaborationWebSocket = (
  repository: DocumentRepository,
  options: {
    now: () => Date
    heartbeatIntervalMs: number
    persistenceDebounceMs: number
    persistenceMaxWaitMs: number
    allowedOrigins?: Set<string>
  },
): CollaborationWebSocket => {
  const { now, heartbeatIntervalMs, persistenceDebounceMs, persistenceMaxWaitMs, allowedOrigins } = options
  const rooms = new Map<string, Room>()
  const webSocketServer = new WebSocketServer({ noServer: true })
  const aliveClients = new WeakSet<WebSocket>()
  const responseCache = new WeakMap<WebSocket, Map<string, Uint8Array>>()
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
  }, heartbeatIntervalMs)
  heartbeatInterval.unref()

  const getResponseCache = (socket: WebSocket): Map<string, Uint8Array> => {
    let cache = responseCache.get(socket)
    if (!cache) {
      cache = new Map()
      responseCache.set(socket, cache)
    }
    return cache
  }

  const flushRoom = (documentId: string, room: Room): void => {
    if (room.debounceTimer) {
      clearTimeout(room.debounceTimer)
      room.debounceTimer = undefined
    }
    if (room.maxWaitTimer) {
      clearTimeout(room.maxWaitTimer)
      room.maxWaitTimer = undefined
    }

    if (!room.dirty || room.pendingUpdates.length === 0) return

    const updates = room.pendingUpdates.splice(0)
    const merged = mergeUpdates(updates)

    try {
      const { revision } = repository.appendUpdates(documentId, [merged], now().toISOString())
      room.revision = revision
      room.dirty = false
    } catch {
      room.pendingUpdates.unshift(...updates)
    }
  }

  const schedulePersistence = (documentId: string, room: Room): void => {
    if (!room.dirty) return

    if (room.debounceTimer) clearTimeout(room.debounceTimer)
    room.debounceTimer = setTimeout(() => flushRoom(documentId, room), persistenceDebounceMs)

    if (!room.maxWaitTimer) {
      room.maxWaitTimer = setTimeout(() => flushRoom(documentId, room), persistenceMaxWaitMs)
    }
  }

  const persistAndDestroyRoom = (documentId: string, room: Room): void => {
    if (rooms.get(documentId) !== room) return

    if (room.debounceTimer) {
      clearTimeout(room.debounceTimer)
      room.debounceTimer = undefined
    }
    if (room.maxWaitTimer) {
      clearTimeout(room.maxWaitTimer)
      room.maxWaitTimer = undefined
    }

    if (room.dirty && room.pendingUpdates.length > 0) {
      const updates = room.pendingUpdates.splice(0)
      const merged = mergeUpdates(updates)

      try {
        const { revision } = repository.appendUpdates(documentId, [merged], now().toISOString())
        room.revision = revision
        room.dirty = false
      } catch {
        room.pendingUpdates.unshift(...updates)
      }
    }

    if (room.dirty) {
      repository.saveState(
        documentId,
        Y.encodeStateAsUpdate(room.doc),
        now().toISOString(),
      )
    }

    rooms.delete(documentId)
    room.doc.destroy()
  }

  const broadcastAwarenessRemoval = (room: Room, clientId: number): void => {
    for (const client of room.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.terminate()
      }
    }
  }

  const getOrCreateRoom = (documentId: string): Room => {
    const activeRoom = rooms.get(documentId)
    if (activeRoom) return activeRoom

    const stored = repository.get(documentId)
    if (!stored) throw new Error('Cannot open a room for a missing document')

    const doc = new Y.Doc()
    doc.getXmlFragment(TIPTAP_FRAGMENT)
    doc.getText(DOCUMENT_TEXT)
    Y.applyUpdate(doc, stored.state)
    const room: Room = {
      doc,
      clients: new Set(),
      dirty: false,
      pendingUpdates: [],
      revision: stored.yRevision,
      awareness: new Awareness(doc),
      ownership: new Map(),
      socketToClientId: new WeakMap(),
    }

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      room.dirty = true
      room.pendingUpdates.push(update)
      schedulePersistence(documentId, room)

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

  const handleAwareness = (socket: WebSocket, room: Room, data: Uint8Array): void => {
    const decoder = decoding.createDecoder(data)
    const type = decoding.readVarUint(decoder)

    if (type === MESSAGE_AWARENESS) {
      if (!decoding.hasContent(decoder)) return

      let body: Uint8Array
      try {
        body = decoding.readVarUint8Array(decoder)

        const bodyDecoder = decoding.createDecoder(body)
        const count = decoding.readVarUint(bodyDecoder)
        let hasForeignUpdate = false
        for (let i = 0; i < count; i++) {
          const clientId = decoding.readVarUint(bodyDecoder)
          const _clock = decoding.readVarUint(bodyDecoder)
          const state = JSON.parse(decoding.readVarString(bodyDecoder))

          if (state === null && clientId !== room.socketToClientId.get(socket)) {
            hasForeignUpdate = true
            continue
          }

          const owningSocket = room.ownership.get(clientId)
          if (owningSocket !== undefined && owningSocket !== socket) {
            hasForeignUpdate = true
            continue
          }
        }

        if (hasForeignUpdate) return
      } catch {
        socket.close(1002, 'Invalid awareness message')
        return
      }

      applyAwarenessUpdate(room.awareness, body, socket)
      updateOwnershipFromAwareness(room, body, socket)

      for (const client of room.clients) {
        if (client !== socket && client.readyState === WebSocket.OPEN) {
          client.send(data)
        }
      }
    } else if (type === MESSAGE_AWARENESS_QUERY) {
      if (room.awareness.getStates().size === 0) return

      const body = encodeAwarenessUpdate(
        room.awareness,
        Array.from(room.awareness.getStates().keys()),
      )
      const message = encodeAwarenessMessage(body)
      if (socket.readyState === WebSocket.OPEN) socket.send(message)
    }
  }

  const updateOwnershipFromAwareness = (room: Room, body: Uint8Array, socket: WebSocket): void => {
    const bodyDecoder = decoding.createDecoder(body)
    const count = decoding.readVarUint(bodyDecoder)
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(bodyDecoder)
      const _clock = decoding.readVarUint(bodyDecoder)
      const state = JSON.parse(decoding.readVarString(bodyDecoder))

      if (state === null) {
        room.ownership.delete(clientId)
        room.socketToClientId.delete(socket)
      } else {
        room.ownership.set(clientId, socket)
        room.socketToClientId.set(socket, clientId)
      }
    }
  }

  const handleDurability = (socket: WebSocket, room: Room, data: Uint8Array, documentId: string): void => {
    const decoder = decoding.createDecoder(data)
    const type = decoding.readVarUint(decoder)

    if (type !== MESSAGE_DURABILITY) return

    const version = decoding.readVarUint(decoder)
    if (version !== DURABILITY_VERSION) {
      socket.close(1002, 'Unsupported durability version')
      return
    }

    const frameType = decoding.readVarUint(decoder)
    if (frameType !== FLUSH_REQUEST) {
      socket.close(1002, 'Unsupported durability frame')
      return
    }

    const requestId = decoding.readVarUint8Array(decoder)

    let clientStateVector: Uint8Array
    try {
      clientStateVector = decoding.readVarUint8Array(decoder)
    } catch {
      socket.close(1002, 'Invalid durability request')
      return
    }

    const requestIdKey = Buffer.from(requestId).toString('hex')
    const cache = getResponseCache(socket)
    const cached = cache.get(requestIdKey)
    if (cached !== undefined) {
      if (socket.readyState === WebSocket.OPEN) socket.send(cached)
      return
    }

    const roomSV = Y.encodeStateVector(room.doc)
    const svMatches = clientStateVector.byteLength === 0 || stateVectorsEqual(clientStateVector, roomSV)

    if (!svMatches) {
      if (socket.readyState === WebSocket.OPEN) {
        const errorResponse = writePersistenceError(requestId, 'STATE_NOT_AVAILABLE', false)
        socket.send(errorResponse)
      }
      return
    }

    let revision = room.revision
    let updatedAt = now().toISOString()

    if (room.pendingUpdates.length > 0) {
      const updates = room.pendingUpdates.splice(0)
      const merged = mergeUpdates(updates)

      try {
        const { revision: newRevision } = repository.appendUpdates(documentId, [merged], updatedAt)
        revision = newRevision
        room.revision = newRevision
        room.dirty = false
      } catch {
        room.pendingUpdates.unshift(...updates)
        const errorResponse = writePersistenceError(requestId, 'PERSISTENCE_UNAVAILABLE', true)
        if (socket.readyState === WebSocket.OPEN) socket.send(errorResponse)
        return
      }
    }

    const durableSV = Y.encodeStateVector(room.doc)
    const durableResponse = writeDurable(requestId, revision, durableSV, updatedAt)

    cache.set(requestIdKey, durableResponse)
    if (cache.size > DURABILITY_RESPONSE_CACHE_LIMIT) {
      const firstKey = cache.keys().next().value
      if (firstKey !== undefined) cache.delete(firstKey)
    }

    if (socket.readyState === WebSocket.OPEN) socket.send(durableResponse)
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

    socket.on('message', (rawData: RawData, isBinary: boolean) => {
      if (!isBinary) {
        socket.close(1003, 'Binary messages required')
        return
      }

      try {
        const data = toUint8Array(rawData)
        const decoder = decoding.createDecoder(data)
        const type = decoding.readVarUint(decoder)

        switch (type) {
          case MESSAGE_SYNC: {
            const response = encoding.createEncoder()
            encoding.writeVarUint(response, MESSAGE_SYNC)
            syncProtocol.readSyncMessage(decoder, response, room.doc, socket)
            if (encoding.length(response) > 1 && socket.readyState === WebSocket.OPEN) {
              socket.send(encoding.toUint8Array(response))
            }
            break
          }
          case MESSAGE_AWARENESS:
          case MESSAGE_AWARENESS_QUERY:
            handleAwareness(socket, room, data)
            break
          case MESSAGE_DURABILITY:
            handleDurability(socket, room, data, documentId)
            break
        }
      } catch {
        socket.close(1002, 'Invalid message')
      }
    })

    socket.on('close', () => {
      room.clients.delete(socket)

      const clientId = room.socketToClientId.get(socket)
      if (clientId !== undefined) {
        room.ownership.delete(clientId)
        room.socketToClientId.delete(socket)
        broadcastAwarenessRemoval(room, clientId)
        removeAwarenessStates(room.awareness, [clientId], null)
      }

      if (room.clients.size === 0) persistAndDestroyRoom(documentId, room)
    })
  }

  return {
    activeRoomCount: () => rooms.size,
    getActiveDocument: (documentId) => rooms.get(documentId)?.doc,
    isDocumentActive: (documentId) => rooms.has(documentId),
    handleUpgrade: (request, socket, head, documentId) => {
      if (allowedOrigins) {
        const origin = request.headers.origin
        if (origin === undefined || !allowedOrigins.has(origin)) {
          socket.write(
            'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
          )
          socket.destroy()
          return
        }
      }

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        connectToRoom(webSocket, documentId)
      })
    },
    close: () => {
      closePromise ??= (async () => {
        clearInterval(heartbeatInterval)

        for (const client of webSocketServer.clients) client.terminate()

        for (const [documentId, room] of rooms) {
          try {
            persistAndDestroyRoom(documentId, room)
          } catch {
            try {
              persistAndDestroyRoom(documentId, room)
            } catch {
              // give up after second attempt
            }
          }
        }

        await new Promise<void>((resolve) => {
          webSocketServer.close(() => resolve())
        })
      })()
      return closePromise
    },
  }
}