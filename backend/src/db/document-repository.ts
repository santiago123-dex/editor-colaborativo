import type Database from 'better-sqlite3'
import * as Y from 'yjs'

export interface StoredDocument {
  id: string
  createdAt: string
  updatedAt: string
  title: string
  state: Uint8Array
  ownerUserId: string | null
  ownerSessionId: string | null
  yRevision: number
}

export interface DocumentRepository {
  create(id: string, createdAt: string, ownerUserId?: string | null, ownerSessionId?: string | null): void
  list(): Array<Omit<StoredDocument, 'state' | 'yRevision'>>
  get(id: string): StoredDocument | undefined
  updateTitle(id: string, title: string, updatedAt: string): boolean
  saveState(id: string, state: Uint8Array, updatedAt: string): boolean
  delete(id: string): boolean
  setOwner(id: string, userId: string | null, sessionId: string | null): boolean
  appendUpdates(id: string, updates: Uint8Array[], updatedAt: string): { revision: number; updatedAt: string }
  getUpdateLog(id: string): Array<{ revision: number; update: Uint8Array; createdAt: string }>
  recoverState(id: string): StoredDocument | undefined
  compact(id: string): boolean
}

interface DocumentRow {
  id: string
  created_at: string
  updated_at: string
  title: string
  state: Buffer
  owner_user_id: string | null
  owner_session_id: string | null
  y_revision: number
  y_snapshot_revision: number
}

export class SqliteDocumentRepository implements DocumentRepository {
  constructor(private readonly database: Database.Database) {}

  create(id: string, createdAt: string, ownerUserId?: string | null, ownerSessionId?: string | null): void {
    const state = Y.encodeStateAsUpdate(new Y.Doc())
    this.database
      .prepare(
        'INSERT INTO documents (id, created_at, updated_at, title, state, owner_user_id, owner_session_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, createdAt, createdAt, '', Buffer.from(state), ownerUserId ?? null, ownerSessionId ?? null)
  }

  list(): Array<Omit<StoredDocument, 'state' | 'yRevision'>> {
    const rows = this.database
      .prepare(
        'SELECT id, created_at, updated_at, title, owner_user_id, owner_session_id FROM documents ORDER BY created_at ASC, id ASC',
      )
      .all() as Array<Omit<DocumentRow, 'state' | 'y_revision' | 'y_snapshot_revision'>>

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      title: row.title,
      ownerUserId: row.owner_user_id,
      ownerSessionId: row.owner_session_id,
    }))
  }

  get(id: string): StoredDocument | undefined {
    const row = this.database
      .prepare(
        'SELECT id, created_at, updated_at, title, state, owner_user_id, owner_session_id, y_revision, y_snapshot_revision FROM documents WHERE id = ?',
      )
      .get(id) as DocumentRow | undefined

    if (!row) return undefined

    let state: Uint8Array
    if (row.y_revision > row.y_snapshot_revision) {
      const updates = this.database
        .prepare('SELECT revision, "update" FROM document_updates WHERE document_id = ? ORDER BY revision ASC')
        .all(id) as Array<{ revision: number; update: Buffer }>

      const expectedStart = row.y_snapshot_revision + 1
      for (let i = 0; i < updates.length; i++) {
        if (updates[i].revision !== expectedStart + i) {
          throw new Error('Document revision mismatch')
        }
      }

      const tempDoc = new Y.Doc()
      Y.applyUpdate(tempDoc, new Uint8Array(row.state))
      for (const { update } of updates) {
        Y.applyUpdate(tempDoc, new Uint8Array(update))
      }
      state = Y.encodeStateAsUpdate(tempDoc)
      tempDoc.destroy()
    } else {
      state = new Uint8Array(row.state)
    }

    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      title: row.title,
      state,
      ownerUserId: row.owner_user_id,
      ownerSessionId: row.owner_session_id,
      yRevision: row.y_revision,
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
      .prepare('UPDATE documents SET state = ?, updated_at = ?, y_revision = y_revision + 1 WHERE id = ?')
      .run(Buffer.from(state), updatedAt, id)
    return result.changes > 0
  }

  delete(id: string): boolean {
    return this.database.prepare('DELETE FROM documents WHERE id = ?').run(id).changes > 0
  }

  setOwner(id: string, userId: string | null, sessionId: string | null): boolean {
    const result = this.database
      .prepare('UPDATE documents SET owner_user_id = ?, owner_session_id = ? WHERE id = ?')
      .run(userId, sessionId, id)
    return result.changes > 0
  }

  appendUpdates(id: string, updates: Uint8Array[], updatedAt: string): { revision: number; updatedAt: string } {
    return this.database.transaction(() => {
      const doc = this.database
        .prepare('SELECT state, y_revision FROM documents WHERE id = ?')
        .get(id) as { state: Buffer; y_revision: number } | undefined

      if (!doc) throw new Error('Document not found')

      const revision = doc.y_revision + 1
      const tempDoc = new Y.Doc()
      Y.applyUpdate(tempDoc, new Uint8Array(doc.state))
      for (const update of updates) {
        Y.applyUpdate(tempDoc, update)
      }
      const mergedState = Y.encodeStateAsUpdate(tempDoc)
      tempDoc.destroy()

      this.database
        .prepare('INSERT OR IGNORE INTO document_updates (document_id, revision, "update", created_at) VALUES (?, ?, ?, ?)')
        .run(id, revision, Buffer.from(mergedState), updatedAt)

      this.database
        .prepare('UPDATE documents SET y_revision = ?, state = ?, updated_at = ? WHERE id = ?')
        .run(revision, Buffer.from(mergedState), updatedAt, id)

      return { revision, updatedAt }
    })()
  }

  getUpdateLog(id: string): Array<{ revision: number; update: Uint8Array; createdAt: string }> {
    const rows = this.database
      .prepare(
        'SELECT revision, "update", created_at FROM document_updates WHERE document_id = ? ORDER BY revision ASC',
      )
      .all(id) as Array<{ revision: number; update: Buffer; created_at: string }>

    return rows.map((row) => ({
      revision: row.revision,
      update: new Uint8Array(row.update),
      createdAt: row.created_at,
    }))
  }

  recoverState(id: string): StoredDocument | undefined {
    const doc = this.get(id)
    if (!doc) return undefined

    const updates = this.getUpdateLog(id)
    if (updates.length === 0) return doc

    const ydoc = new Y.Doc()
    Y.applyUpdate(ydoc, doc.state)
    for (const { update } of updates) {
      Y.applyUpdate(ydoc, update)
    }

    return {
      ...doc,
      state: Y.encodeStateAsUpdate(ydoc),
    }
  }

  compact(id: string): boolean {
    return this.database.transaction(() => {
      const doc = this.database
        .prepare('SELECT state, y_revision, y_snapshot_revision FROM documents WHERE id = ?')
        .get(id) as { state: Buffer; y_revision: number; y_snapshot_revision: number } | undefined

      if (!doc) return false
      if (doc.y_revision === doc.y_snapshot_revision) return true

      const updates = this.database
        .prepare('SELECT "update" FROM document_updates WHERE document_id = ? ORDER BY revision ASC')
        .all(id) as Array<{ update: Buffer }>

      const tempDoc = new Y.Doc()
      Y.applyUpdate(tempDoc, new Uint8Array(doc.state))
      for (const { update } of updates) {
        Y.applyUpdate(tempDoc, new Uint8Array(update))
      }

      const fullState = Y.encodeStateAsUpdate(tempDoc)
      tempDoc.destroy()

      this.database
        .prepare('UPDATE documents SET state = ?, y_snapshot_revision = y_revision WHERE id = ?')
        .run(Buffer.from(fullState), id)

      this.database
        .prepare('DELETE FROM document_updates WHERE document_id = ?')
        .run(id)

      return true
    })()
  }
}
