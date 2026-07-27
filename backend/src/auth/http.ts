import type { NextFunction, Request, Response } from 'express'
import { createCsrfToken, safeEqual } from './crypto.js'
import type { AuthRepository, Session } from './repository.js'

export interface AuthHttpOptions {
  allowedOrigins: Set<string>
  cookieName: string
  csrfSecret: string
  secureCookies: boolean
  sessionTtlMs: number
  authRateLimitMax: number
  authRateLimitWindowMs: number
  now: () => Date
}

export interface AuthRequest extends Request {
  session?: Session
}

export const parseCookie = (header: string | undefined, name: string): string | undefined => {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    return part.slice(separator + 1).trim() || undefined
  }
  return undefined
}

export const setSessionCookie = (response: Response, session: Session, options: AuthHttpOptions): void => {
  response.cookie(options.cookieName, session.rawToken, {
    httpOnly: true,
    path: '/',
    sameSite: options.secureCookies ? 'none' : 'lax',
    secure: options.secureCookies,
    maxAge: options.sessionTtlMs,
  })
}

export const sessionBody = (session: Session, csrfSecret: string) => ({
  user: session.user,
  csrfToken: createCsrfToken(csrfSecret, session.rawToken),
})

export const createSessionResolver = (repository: AuthRepository, options: AuthHttpOptions) =>
  (request: AuthRequest, _response: Response, next: NextFunction) => {
    const rawToken = parseCookie(request.headers.cookie, options.cookieName)
    if (rawToken) request.session = repository.findSession(rawToken, options.now())
    next()
  }

export const createUnsafeGuard = (options: AuthHttpOptions) =>
  (request: AuthRequest, response: Response, next: NextFunction) => {
    if (!request.session) {
      response.status(401).json({ error: 'Authentication required', code: 'SESSION_REQUIRED' })
      return
    }
    const origin = request.get('Origin')
    if (!origin || !options.allowedOrigins.has(origin)) {
      response.status(403).json({ error: 'Origin not allowed', code: 'ORIGIN_INVALID' })
      return
    }
    const csrfToken = request.get('X-CSRF-Token')
    const expected = createCsrfToken(options.csrfSecret, request.session.rawToken)
    if (!csrfToken || !safeEqual(csrfToken, expected)) {
      response.status(403).json({ error: 'Invalid CSRF token', code: 'CSRF_INVALID' })
      return
    }
    next()
  }
