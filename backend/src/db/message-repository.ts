import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface StoredMessage {
  id: string
  documentId: string
  clientMessageId: string
  author: string
  content: string
  createdAt: string
}

export type CreateMessageResult =
  | { status: 'created' | 'duplicate'; message: StoredMessage }
  | { status: 'conflict' }

export interface MessageRepository {
  listRecent(documentId: string, limit: number): StoredMessage[]
  createIdempotent(
    documentId: string,
    clientMessageId: string,
    author: string,
    content: string,
    createdAt: string,
  ): CreateMessageResult
}

interface MessageRow {
  id: string
  document_id: string
  client_message_id: string
  author: string
  content: string
  created_at: string
}

const toStoredMessage = (row: MessageRow): StoredMessage => ({
  id: row.id,
  documentId: row.document_id,
  clientMessageId: row.client_message_id,
  author: row.author,
  content: row.content,
  createdAt: row.created_at,
})

export class SqliteMessageRepository implements MessageRepository {
  private readonly createTransaction: (
    documentId: string,
    clientMessageId: string,
    author: string,
    content: string,
    createdAt: string,
  ) => CreateMessageResult

  constructor(private readonly database: Database.Database) {
    this.createTransaction = database.transaction(
      (
        documentId: string,
        clientMessageId: string,
        author: string,
        content: string,
        createdAt: string,
      ): CreateMessageResult => {
        const existing = this.database
          .prepare(
            `SELECT id, document_id, client_message_id, author, content, created_at
             FROM messages WHERE document_id = ? AND client_message_id = ?`,
          )
          .get(documentId, clientMessageId) as MessageRow | undefined

        if (existing) {
          if (existing.author !== author || existing.content !== content) return { status: 'conflict' }
          return { status: 'duplicate', message: toStoredMessage(existing) }
        }

        const message: StoredMessage = {
          id: randomUUID(),
          documentId,
          clientMessageId,
          author,
          content,
          createdAt,
        }
        this.database
          .prepare(
            `INSERT INTO messages
               (id, document_id, client_message_id, author, content, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            message.id,
            message.documentId,
            message.clientMessageId,
            message.author,
            message.content,
            message.createdAt,
          )
        return { status: 'created', message }
      },
    )
  }

  listRecent(documentId: string, limit: number): StoredMessage[] {
    const rows = this.database
      .prepare(
        `SELECT id, document_id, client_message_id, author, content, created_at
         FROM messages
         WHERE document_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(documentId, limit) as MessageRow[]
    return rows.reverse().map(toStoredMessage)
  }

  createIdempotent(
    documentId: string,
    clientMessageId: string,
    author: string,
    content: string,
    createdAt: string,
  ): CreateMessageResult {
    return this.createTransaction(documentId, clientMessageId, author, content, createdAt)
  }
}
