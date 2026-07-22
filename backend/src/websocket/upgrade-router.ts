import type { Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { UUID_PATTERN } from '../constants.js'
import type { DocumentRepository } from '../db/document-repository.js'
import type { ChatWebSocket } from './chat.js'
import type { CollaborationWebSocket } from './collaboration.js'

const sendHttpError = (socket: Duplex, status: 400 | 404, message: string) => {
  const body = JSON.stringify({ error: message })
  socket.end(
    `HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : 'Bad Request'}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  )
}

export const attachUpgradeRouter = (
  httpServer: HttpServer,
  repository: DocumentRepository,
  collaboration: CollaborationWebSocket,
  chat: ChatWebSocket,
): void => {
  httpServer.on('upgrade', (request, socket, head) => {
    let route: CollaborationWebSocket | ChatWebSocket | undefined
    let documentId: string | undefined
    try {
      const pathname = new URL(request.url ?? '', 'http://localhost').pathname
      const chatMatch = /^\/ws\/chat\/([^/]+)$/.exec(pathname)
      const collaborationMatch = /^\/ws\/([^/]+)$/.exec(pathname)
      if (chatMatch) {
        route = chat
        documentId = decodeURIComponent(chatMatch[1])
      } else if (collaborationMatch) {
        route = collaboration
        documentId = decodeURIComponent(collaborationMatch[1])
      }
    } catch {
      sendHttpError(socket, 400, 'Bad request')
      return
    }

    if (!route || !documentId || !UUID_PATTERN.test(documentId) || !repository.get(documentId)) {
      sendHttpError(socket, 404, 'Document not found')
      return
    }
    route.handleUpgrade(request, socket, head, documentId)
  })
}
