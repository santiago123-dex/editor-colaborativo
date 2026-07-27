import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { UUID_PATTERN } from '../constants.js'
import type { MessageRepository, StoredMessage } from '../db/message-repository.js'

interface ChatRoom {
  clients: Set<WebSocket>
}

interface ClientMessage {
  type: 'message:create'
  clientMessageId: string
  author: string
  content: string
}

export interface ChatWebSocket {
  activeRoomCount: () => number
  isDocumentActive: (documentId: string) => boolean
  handleUpgrade: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    documentId: string,
  ) => void
  close: () => Promise<void>
}

const sendJson = (socket: WebSocket, value: unknown) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
}

const sendError = (
  socket: WebSocket,
  code:
    | 'INVALID_MESSAGE'
    | 'UNSUPPORTED_MESSAGE_TYPE'
    | 'CLIENT_MESSAGE_ID_CONFLICT'
    | 'INTERNAL_ERROR',
  message: string,
  clientMessageId?: string,
) => {
  sendJson(socket, {
    type: 'error',
    code,
    message,
    ...(clientMessageId === undefined ? {} : { clientMessageId }),
  })
}

const parseMessage = (value: unknown): ClientMessage | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.type !== 'message:create') return undefined
  if (typeof candidate.clientMessageId !== 'string' || !UUID_PATTERN.test(candidate.clientMessageId)) {
    return undefined
  }
  if (typeof candidate.author !== 'string' || typeof candidate.content !== 'string') return undefined
  const author = candidate.author.trim()
  const content = candidate.content.trim()
  if (author.length < 1 || author.length > 40 || content.length < 1 || content.length > 1_000) {
    return undefined
  }
  return { type: 'message:create', clientMessageId: candidate.clientMessageId, author, content }
}

export const createChatWebSocket = (
  repository: MessageRepository,
  options: {
    now: () => Date
    heartbeatIntervalMs: number
    afterTransportClose?: () => void
  },
): ChatWebSocket => {
  const rooms = new Map<string, ChatRoom>()
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
  const aliveClients = new WeakSet<WebSocket>()
  let closePromise: Promise<void> | undefined
  let shuttingDown = false

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

  const broadcast = (room: ChatRoom, message: StoredMessage) => {
    for (const client of room.clients) sendJson(client, { type: 'message:created', message })
  }

  const connectToRoom = (socket: WebSocket, documentId: string) => {
    const room = rooms.get(documentId) ?? { clients: new Set<WebSocket>() }
    rooms.set(documentId, room)
    room.clients.add(socket)
    aliveClients.add(socket)
    // Receiver errors already trigger the corresponding WebSocket protocol close.
    socket.on('error', () => undefined)
    socket.on('pong', () => aliveClients.add(socket))

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        socket.close(1003, 'Text messages required')
        return
      }

      let value: unknown
      try {
        value = JSON.parse(data.toString())
      } catch {
        socket.close(1007, 'Invalid JSON')
        return
      }

      const candidate = value as Record<string, unknown> | null
      const clientMessageId =
        candidate !== null && typeof candidate === 'object' && typeof candidate.clientMessageId === 'string'
          ? candidate.clientMessageId
          : undefined
      if (candidate !== null && typeof candidate === 'object' && candidate.type !== 'message:create') {
        sendError(socket, 'UNSUPPORTED_MESSAGE_TYPE', 'Unsupported message type', clientMessageId)
        return
      }

      const message = parseMessage(value)
      if (!message) {
        sendError(socket, 'INVALID_MESSAGE', 'Invalid message', clientMessageId)
        return
      }

      try {
        const result = repository.createIdempotent(
          documentId,
          message.clientMessageId,
          message.author,
          message.content,
          options.now().toISOString(),
        )
        if (result.status === 'conflict') {
          sendError(
            socket,
            'CLIENT_MESSAGE_ID_CONFLICT',
            'Client message id already has different content',
            message.clientMessageId,
          )
        } else if (result.status === 'duplicate') {
          sendJson(socket, { type: 'message:created', message: result.message })
        } else {
          broadcast(room, result.message)
        }
      } catch (error) {
        console.error(error)
        sendError(socket, 'INTERNAL_ERROR', 'Could not persist message', message.clientMessageId)
      }
    })

    socket.on('close', () => {
      if (shuttingDown) return
      room.clients.delete(socket)
      if (room.clients.size === 0 && rooms.get(documentId) === room) rooms.delete(documentId)
    })
  }

  return {
    activeRoomCount: () => rooms.size,
    isDocumentActive: (documentId) => rooms.has(documentId),
    handleUpgrade: (request, socket, head, documentId) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        connectToRoom(webSocket, documentId)
      })
    },
    close: () => {
      closePromise ??= (async () => {
        clearInterval(heartbeatInterval)
        shuttingDown = true
        for (const client of webSocketServer.clients) client.terminate()
        await new Promise<void>((resolve) => {
          webSocketServer.close(() => resolve())
        })
        try {
          options.afterTransportClose?.()
        } catch (error) {
          closePromise = undefined
          shuttingDown = false
          throw error
        }
        rooms.clear()
      })()
      return closePromise
    },
  }
}
