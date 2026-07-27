import { randomBytes } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import cors from 'cors'
import express, { type Express, type Request } from 'express'
import { createDatabase } from './db/connection.js'
import { SqliteDocumentRepository } from './db/document-repository.js'
import { SqliteMessageRepository } from './db/message-repository.js'
import { initializeSchema } from './db/schema.js'
import { createDocumentsRouter } from './routes/documents.js'
import { createAuthRouter } from './routes/auth.js'
import { createCollaborationWebSocket } from './websocket/collaboration.js'
import { createChatWebSocket } from './websocket/chat.js'
import { attachUpgradeRouter } from './websocket/upgrade-router.js'
import { AuthRepository } from './auth/repository.js'
import { createSessionResolver, createUnsafeGuard, type AuthHttpOptions, type AuthRequest } from './auth/http.js'

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
  persistenceDebounceMs?: number
  persistenceMaxWaitMs?: number
  allowedOrigins?: string[]
  csrfSecret?: string
  secureCookies?: boolean
  sessionCookieName?: string
  production?: boolean
  sessionTtlMs?: number
  authRateLimitMax?: number
  authRateLimitWindowMs?: number
}

export interface CollaborationServerHooks {
  afterChatTransportClose?: () => void
}

export const createCollaborationServer = (
  {
    databasePath,
    now = () => new Date(),
    heartbeatIntervalMs = 30_000,
    persistenceDebounceMs,
    persistenceMaxWaitMs,
    allowedOrigins,
    csrfSecret,
    production = false,
    secureCookies = production,
    sessionCookieName,
    sessionTtlMs = 30 * 24 * 60 * 60 * 1_000,
    authRateLimitMax = 5,
    authRateLimitWindowMs = 60_000,
  }: CollaborationServerOptions,
  hooks?: CollaborationServerHooks,
): CollaborationServer => {
  const effectiveCookieName = sessionCookieName ?? (production ? '__Host-editor_session' : 'editor_session')

  if (production && (!csrfSecret || csrfSecret.length < 32)) {
    throw new Error('CSRF_SECRET must be at least 32 characters in production')
  }

  if (effectiveCookieName.startsWith('__Host-') && !secureCookies) {
    throw new Error('__Host- cookie names require secureCookies')
  }

  const database = createDatabase(databasePath)
  initializeSchema(database)
  const repository = new SqliteDocumentRepository(database)
  const messageRepository = new SqliteMessageRepository(database)
  const app = express()
  const httpServer = createServer(app)

  const resolvedCsrfSecret = csrfSecret ?? (allowedOrigins ? randomBytes(32).toString('hex') : undefined)
  const authEnabled = resolvedCsrfSecret !== undefined
  const corsEnabled = allowedOrigins !== undefined
  const userFacing = corsEnabled && authEnabled

  let authRepository: AuthRepository | undefined
  let authHttpOptions: AuthHttpOptions | undefined

  if (authEnabled) {
    authRepository = new AuthRepository(database, sessionTtlMs)
    authHttpOptions = {
      allowedOrigins: new Set(allowedOrigins ?? []),
      cookieName: effectiveCookieName,
      csrfSecret: resolvedCsrfSecret,
      secureCookies,
      sessionTtlMs,
      authRateLimitMax,
      authRateLimitWindowMs,
      now,
    }
  }

  const allowedOriginSet = new Set(allowedOrigins ?? [])

  const collaboration = createCollaborationWebSocket(repository, {
    now,
    heartbeatIntervalMs,
    persistenceDebounceMs: persistenceDebounceMs ?? 200,
    persistenceMaxWaitMs: persistenceMaxWaitMs ?? 1000,
    allowedOrigins: allowedOriginSet.size > 0 ? allowedOriginSet : undefined,
  })

  const chat = createChatWebSocket(messageRepository, {
    now,
    heartbeatIntervalMs,
    afterTransportClose: hooks?.afterChatTransportClose,
  })

  attachUpgradeRouter(httpServer, repository, collaboration, chat, allowedOriginSet)

  let closePromise: Promise<void> | undefined

  if (allowedOriginSet.size > 0) {
    app.use(cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true)
        if (allowedOriginSet.has(origin)) return callback(null, true)
        callback(null, false)
      },
      credentials: true,
    }))
  } else {
    app.use(cors())
  }

  app.get('/healthz', (_request, response) => {
    response.status(200).json({ status: 'ok' })
  })

  app.use(express.json({ limit: '1mb' }))

  const getSession = (request: Request) => (request as AuthRequest).session

  if (authEnabled && authRepository && authHttpOptions) {
    app.use(createSessionResolver(authRepository, authHttpOptions))
    app.use('/auth', createAuthRouter(authRepository, authHttpOptions))
    if (userFacing) {
      app.use((request, response, next) => {
        if (request.method === 'GET' || request.method === 'HEAD') return next()
        createUnsafeGuard(authHttpOptions!)(request as AuthRequest, response, next)
      })
    }
    app.use(
      '/documents',
      createDocumentsRouter(
        repository,
        messageRepository,
        collaboration.getActiveDocument,
        (documentId) => collaboration.isDocumentActive(documentId) || chat.isDocumentActive(documentId),
        getSession,
      ),
    )
  } else {
    app.use(
      '/documents',
      createDocumentsRouter(
        repository,
        messageRepository,
        collaboration.getActiveDocument,
        (documentId) => collaboration.isDocumentActive(documentId) || chat.isDocumentActive(documentId),
      ),
    )
  }

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
        const errors: unknown[] = []

        try {
          await collaboration.close()
        } catch (error) {
          errors.push(error)
        }

        try {
          await chat.close()
        } catch (error) {
          errors.push(error)
        }

        if (httpServer.listening) {
          try {
            await new Promise<void>((resolve, reject) => {
              httpServer.close((error) => (error ? reject(error) : resolve()))
            })
          } catch (error) {
            errors.push(error)
          }
        }

        if (errors.length > 0) {
          closePromise = undefined
          throw { errors }
        }

        database.close()
      })()
      return closePromise
    },
  }
}
