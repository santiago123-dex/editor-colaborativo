import type Database from 'better-sqlite3'
import * as Y from 'yjs'

export interface StoredDocument {
  id: string
  createdAt: string
  updatedAt: string
  title: string
  state: Uint8Array
}

export interface DocumentRepository {
  create(id: string, createdAt: string): void
  list(): Array<Omit<StoredDocument, 'state'>>
  get(id: string): StoredDocument | undefined
  updateTitle(id: string, title: string, updatedAt: string): boolean
  saveState(id: string, state: Uint8Array, updatedAt: string): boolean
  delete(id: string): boolean
}

interface DocumentRow {
  id: string
  created_at: string
  updated_at: string
  title: string
  state: Buffer
}

export class SqliteDocumentRepository implements DocumentRepository {
  constructor(private readonly database: Database.Database) {}

  create(id: string, createdAt: string): void {
    const state = Y.encodeStateAsUpdate(new Y.Doc())
    this.database
      .prepare(
        'INSERT INTO documents (id, created_at, updated_at, title, state) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, createdAt, createdAt, '', Buffer.from(state))
  }

  list(): Array<Omit<StoredDocument, 'state'>> {
    const rows = this.database
      .prepare(
        'SELECT id, created_at, updated_at, title FROM documents ORDER BY created_at ASC, id ASC',
      )
      .all() as Array<Omit<DocumentRow, 'state'>>

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      title: row.title,
    }))
  }

  get(id: string): StoredDocument | undefined {
    const row = this.database
      .prepare('SELECT id, created_at, updated_at, title, state FROM documents WHERE id = ?')
      .get(id) as DocumentRow | undefined

    if (!row) return undefined
    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      title: row.title,
      state: new Uint8Array(row.state),
    }
  }

  updateTitle(id: string, title: string, updatedAt: string): boolean {
    const result = this.database
      .prepare('UPDATE documents SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, updatedAt, id)
    return result.changes > 0
  }

  saveState(id: string, state: Uint8Array, updatedAt: string): boolean {
    // State and timestamp must become durable together when the room is released.
    const result = this.database
      .prepare('UPDATE documents SET state = ?, updated_at = ? WHERE id = ?')
      .run(Buffer.from(state), updatedAt, id)
    return result.changes > 0
  }

  delete(id: string): boolean {
    return this.database.prepare('DELETE FROM documents WHERE id = ?').run(id).changes > 0
  }
}
