import { randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { createSessionToken, hashSessionToken } from './crypto.js'

export interface User {
  id: string
  email: string
}

export interface StoredUser extends User {
  passwordHash: Buffer
  passwordSalt: Buffer
}

export interface Session {
  id: string
  user: User | null
  rawToken: string
}

export class SessionChangedError extends Error {
  constructor() {
    super('Session changed')
    this.name = 'SessionChangedError'
  }
}

interface SessionRow {
  id: string
  user_id: string | null
  email: string | null
}

interface UserRow {
  id: string
  email: string
  password_hash: Buffer
  password_salt: Buffer
}

export class AuthRepository {
  private readonly rotateTransaction: (oldSessionId: string, userId: string | null, now: Date) => Session
  private readonly registerTransaction: (
    oldSessionId: string,
    email: string,
    passwordHash: Buffer,
    passwordSalt: Buffer,
    now: Date,
  ) => Session

  constructor(
    private readonly database: Database.Database,
    private readonly sessionTtlMs: number,
  ) {
    this.rotateTransaction = database.transaction((oldSessionId, userId, now) => {
      this.consumeSession(oldSessionId)
      if (userId) {
        database
          .prepare('UPDATE documents SET owner_user_id = ?, owner_session_id = NULL WHERE owner_session_id = ?')
          .run(userId, oldSessionId)
      }
      return this.insertSession(userId, now)
    })
    this.registerTransaction = database.transaction(
      (oldSessionId, email, passwordHash, passwordSalt, now) => {
        this.consumeSession(oldSessionId)
        const userId = randomUUID()
        database
          .prepare(
            'INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(userId, email, passwordHash, passwordSalt, now.toISOString())
        database
          .prepare('UPDATE documents SET owner_user_id = ?, owner_session_id = NULL WHERE owner_session_id = ?')
          .run(userId, oldSessionId)
        return this.insertSession(userId, now)
      },
    )
  }

  private consumeSession(sessionId: string): void {
    if (this.database.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId).changes !== 1) {
      throw new SessionChangedError()
    }
  }

  private insertSession(userId: string | null, now: Date): Session {
    const rawToken = createSessionToken()
    const id = randomUUID()
    this.database
      .prepare('INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(
        id,
        hashSessionToken(rawToken),
        userId,
        now.toISOString(),
        new Date(now.getTime() + this.sessionTtlMs).toISOString(),
      )
    const user = userId
      ? (this.database.prepare('SELECT id, email FROM users WHERE id = ?').get(userId) as User)
      : null
    return { id, user, rawToken }
  }

  createAnonymous(now: Date): Session {
    return this.insertSession(null, now)
  }

  findSession(rawToken: string, now: Date): Session | undefined {
    const row = this.database
      .prepare(
        `SELECT sessions.id, sessions.user_id, users.email
         FROM sessions LEFT JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
      )
      .get(hashSessionToken(rawToken), now.toISOString()) as SessionRow | undefined
    if (!row) {
      this.database
        .prepare(
          `DELETE FROM sessions
           WHERE token_hash = ?
             AND expires_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM documents WHERE documents.owner_session_id = sessions.id
             )`,
        )
        .run(hashSessionToken(rawToken), now.toISOString())
      return undefined
    }
    return {
      id: row.id,
      user: row.user_id ? { id: row.user_id, email: row.email! } : null,
      rawToken,
    }
  }

  renewSession(sessionId: string, now: Date): boolean {
    return this.database
      .prepare('UPDATE sessions SET expires_at = ? WHERE id = ? AND expires_at > ?')
      .run(
        new Date(now.getTime() + this.sessionTtlMs).toISOString(),
        sessionId,
        now.toISOString(),
      ).changes === 1
  }

  findUser(email: string): StoredUser | undefined {
    const row = this.database
      .prepare('SELECT id, email, password_hash, password_salt FROM users WHERE email = ?')
      .get(email) as UserRow | undefined
    return row
      ? {
          id: row.id,
          email: row.email,
          passwordHash: row.password_hash,
          passwordSalt: row.password_salt,
        }
      : undefined
  }

  register(
    sessionId: string,
    email: string,
    passwordHash: Buffer,
    passwordSalt: Buffer,
    now: Date,
  ): Session {
    return this.registerTransaction(sessionId, email, passwordHash, passwordSalt, now)
  }

  rotate(sessionId: string, userId: string | null, now: Date): Session {
    return this.rotateTransaction(sessionId, userId, now)
  }

  dummyCredentials(): { salt: Buffer; hash: Buffer } {
    return { salt: randomBytes(16), hash: randomBytes(64) }
  }
}
