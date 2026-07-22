import { createServer, type Server as HttpServer } from 'node:http'
import cors from 'cors'
import express, { type Express } from 'express'
import { createDatabase } from './db/connection.js'
import { SqliteDocumentRepository } from './db/document-repository.js'
import { SqliteMessageRepository } from './db/message-repository.js'
import { initializeSchema } from './db/schema.js'
import { createDocumentsRouter } from './routes/documents.js'
import { createCollaborationWebSocket } from './websocket/collaboration.js'
import { createChatWebSocket } from './websocket/chat.js'
import { attachUpgradeRouter } from './websocket/upgrade-router.js'

export interface CollaborationServer {
  app: Express
  httpServer: HttpServer
  activeRoomCount: () => number
  activeChatRoomCount: () => number
  close: () => Promise<void>
}

export interface CollaborationServerOptions {
  databasePath: string
  now?: () => Date
  heartbeatIntervalMs?: number
}

export const createCollaborationServer = ({
  databasePath,
  now = () => new Date(),
  heartbeatIntervalMs = 30_000,
}: CollaborationServerOptions): CollaborationServer => {
  const database = createDatabase(databasePath)
  initializeSchema(database)
  const repository = new SqliteDocumentRepository(database)
  const messageRepository = new SqliteMessageRepository(database)
  const app = express()
  const httpServer = createServer(app)
  const collaboration = createCollaborationWebSocket(repository, {
    now,
    heartbeatIntervalMs,
  })
  const chat = createChatWebSocket(messageRepository, { now, heartbeatIntervalMs })
  attachUpgradeRouter(httpServer, repository, collaboration, chat)
  let closePromise: Promise<void> | undefined

  app.use(cors())
  app.use(express.json({ limit: '1mb' }))
  app.use(
    '/documents',
    createDocumentsRouter(
      repository,
      messageRepository,
      collaboration.getActiveDocument,
      (documentId) =>
        collaboration.isDocumentActive(documentId) || chat.isDocumentActive(documentId),
    ),
  )

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found' })
  })

  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        typeof error === 'object' && error !== null && 'status' in error && error.status === 400
          ? 400
          : 500
      if (status === 500) console.error(error)
      response.status(status).json({ error: status === 400 ? 'Bad request' : 'Internal server error' })
    },
  )

  return {
    app,
    httpServer,
    activeRoomCount: collaboration.activeRoomCount,
    activeChatRoomCount: chat.activeRoomCount,
    close: () => {
      closePromise ??= (async () => {
        await collaboration.close()
        await chat.close()
        if (httpServer.listening) {
          await new Promise<void>((resolve, reject) => {
            httpServer.close((error) => (error ? reject(error) : resolve()))
          })
        }
        database.close()
      })()
      return closePromise
    },
  }
}
