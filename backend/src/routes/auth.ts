import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import { hashPassword, verifyPassword } from '../auth/crypto.js'
import {
  createUnsafeGuard,
  sessionBody,
  setSessionCookie,
  type AuthHttpOptions,
  type AuthRequest,
} from '../auth/http.js'
import { AuthRepository, SessionChangedError } from '../auth/repository.js'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const normalizeEmail = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const email = value.trim().toLowerCase()
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : undefined
}
const validPassword = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 12 && value.length <= 128

export const createAuthRouter = (repository: AuthRepository, options: AuthHttpOptions): Router => {
  const router = Router()
  const dummy = repository.dummyCredentials()
  const attempts = new Map<string, { count: number; resetAt: number }>()

  const rateLimit = (request: AuthRequest, response: Response, email: string): boolean => {
    const now = options.now().getTime()
    for (const [key, attempt] of attempts) {
      if (attempt.resetAt <= now) attempts.delete(key)
    }
    const key = `${request.ip ?? request.socket.remoteAddress ?? ''}\n${email}`
    const attempt = attempts.get(key)
    if (!attempt) {
      attempts.set(key, { count: 1, resetAt: now + options.authRateLimitWindowMs })
      return false
    }
    if (attempt.count >= options.authRateLimitMax) {
      response
        .set('Retry-After', String(Math.max(1, Math.ceil((attempt.resetAt - now) / 1_000))))
        .status(429)
        .json({ error: 'Too many authentication attempts', code: 'RATE_LIMITED' })
      return true
    }
    attempt.count += 1
    return false
  }

  const sessionChanged = (error: unknown, response: Response): boolean => {
    if (!(error instanceof SessionChangedError)) return false
    response.status(409).json({ error: 'Session changed', code: 'SESSION_CHANGED' })
    return true
  }

  router.get('/session', (request: AuthRequest, response) => {
    let session = request.session
    if (session) {
      const now = options.now()
      if (!repository.renewSession(session.id, now)) session = repository.createAnonymous(now)
    } else {
      session = repository.createAnonymous(options.now())
    }
    setSessionCookie(response, session, options)
    response.set('Cache-Control', 'no-store').json(sessionBody(session, options.csrfSecret))
  })

  router.use(createUnsafeGuard(options))

  router.post('/register', async (request: AuthRequest, response: Response, next: NextFunction) => {
    const email = normalizeEmail(request.body?.email)
    if (!email || !validPassword(request.body?.password)) {
      response.status(400).json({ error: 'Invalid email or password', code: 'INVALID_INPUT' })
      return
    }
    if (rateLimit(request, response, email)) return
    if (repository.findUser(email)) {
      response.status(409).json({ error: 'Email already registered', code: 'EMAIL_EXISTS' })
      return
    }
    const password = await hashPassword(request.body.password)
    try {
      const session = repository.register(
        request.session!.id,
        email,
        password.hash,
        password.salt,
        options.now(),
      )
      setSessionCookie(response, session, options)
      response.status(201).json(sessionBody(session, options.csrfSecret))
    } catch (error) {
      if (sessionChanged(error, response)) return
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed: users.email')) {
        response.status(409).json({ error: 'Email already registered', code: 'EMAIL_EXISTS' })
        return
      }
      next(error)
    }
  })

  router.post('/login', async (request: AuthRequest, response) => {
    const email = normalizeEmail(request.body?.email)
    const password = request.body?.password
    if (!email || !validPassword(password)) {
      response.status(400).json({ error: 'Invalid email or password', code: 'INVALID_INPUT' })
      return
    }
    if (rateLimit(request, response, email)) return
    const user = repository.findUser(email)
    const valid = await verifyPassword(
      password,
      user?.passwordSalt ?? dummy.salt,
      user?.passwordHash ?? dummy.hash,
    )
    if (!user || !valid) {
      response.status(401).json({ error: 'Invalid email or password', code: 'INVALID_CREDENTIALS' })
      return
    }
    try {
      const session = repository.rotate(request.session!.id, user.id, options.now())
      setSessionCookie(response, session, options)
      response.json(sessionBody(session, options.csrfSecret))
    } catch (error) {
      if (!sessionChanged(error, response)) throw error
    }
  })

  router.post('/logout', (request: AuthRequest, response) => {
    try {
      const session = repository.rotate(request.session!.id, null, options.now())
      setSessionCookie(response, session, options)
      response.json(sessionBody(session, options.csrfSecret))
    } catch (error) {
      if (!sessionChanged(error, response)) throw error
    }
  })

  return router
}
