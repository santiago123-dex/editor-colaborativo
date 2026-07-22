import type Database from 'better-sqlite3'
import * as Y from 'yjs'

export interface StoredDocument {
  id: string
  createdAt: string
  title: string
  state: Uint8Array
}

export interface DocumentRepository {
  create(id: string, createdAt: string): void
  list(): Array<Omit<StoredDocument, 'state'>>
  get(id: string): StoredDocument | undefined
  saveState(id: string, state: Uint8Array): void
}

interface DocumentRow {
  id: string
  created_at: string
  title: string
  state: Buffer
}

export class SqliteDocumentRepository implements DocumentRepository {
  constructor(private readonly database: Database.Database) {}

  create(id: string, createdAt: string): void {
    const state = Y.encodeStateAsUpdate(new Y.Doc())
    this.database
      .prepare('INSERT INTO documents (id, created_at, title, state) VALUES (?, ?, ?, ?)')
      .run(id, createdAt, '', Buffer.from(state))
  }

  list(): Array<Omit<StoredDocument, 'state'>> {
    const rows = this.database
      .prepare('SELECT id, created_at, title FROM documents ORDER BY created_at ASC, id ASC')
      .all() as Array<Omit<DocumentRow, 'state'>>

    return rows.map((row) => ({ id: row.id, createdAt: row.created_at, title: row.title }))
  }

  get(id: string): StoredDocument | undefined {
    const row = this.database
      .prepare('SELECT id, created_at, title, state FROM documents WHERE id = ?')
      .get(id) as DocumentRow | undefined

    if (!row) return undefined
    return {
      id: row.id,
      createdAt: row.created_at,
      title: row.title,
      state: new Uint8Array(row.state),
    }
  }

  saveState(id: string, state: Uint8Array): void {
    this.database.prepare('UPDATE documents SET state = ? WHERE id = ?').run(Buffer.from(state), id)
  }
}
