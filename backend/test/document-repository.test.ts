import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createDatabase } from '../src/db/connection.js'
import { SqliteDocumentRepository } from '../src/db/document-repository.js'
import { initializeSchema } from '../src/db/schema.js'

const documentId = '00000000-0000-4000-8000-000000000001'
const createdAt = '2026-01-01T00:00:00.000Z'

const updateFor = (value: string): Uint8Array => {
  const doc = new Y.Doc()
  doc.getText('document-content').insert(0, value)
  return Y.encodeStateAsUpdate(doc)
}

const textFrom = (state: Uint8Array): string => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc.getText('document-content').toString()
}

describe('incremental document persistence', () => {
  let database: Database.Database | undefined

  afterEach(() => database?.close())

  const setup = () => {
    database = createDatabase(':memory:')
    initializeSchema(database)
    const repository = new SqliteDocumentRepository(database)
    repository.create(documentId, createdAt, null, 'session')
    return repository
  }

  it('configures durable SQLite writes with a short busy timeout', () => {
    database = createDatabase(':memory:')
    expect(database.pragma('synchronous', { simple: true })).toBe(2)
    expect(database.pragma('busy_timeout', { simple: true })).toBeGreaterThan(0)
    expect(database.pragma('busy_timeout', { simple: true })).toBeLessThanOrEqual(2_000)
  })

  it('migrates revision columns and the update log idempotently without losing legacy data', () => {
    database = new Database(':memory:')
    database.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        state BLOB NOT NULL
      );
      CREATE TABLE legacy_messages (value TEXT NOT NULL);
      INSERT INTO legacy_messages VALUES ('preserved');
    `)
    initializeSchema(database)
    initializeSchema(database)

    const columns = database.pragma('table_info(documents)') as Array<{ name: string; notnull: number; dflt_value: string }>
    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'y_revision', notnull: 1, dflt_value: '0' }),
      expect.objectContaining({ name: 'y_snapshot_revision', notnull: 1, dflt_value: '0' }),
    ]))
    const table = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'document_updates'").pluck().get() as string
    expect(table).toContain('WITHOUT ROWID')
    expect(database.prepare('SELECT value FROM legacy_messages').pluck().get()).toBe('preserved')
  })

  it('appends one merged update per batch and advances revision and updatedAt atomically', () => {
    const repository = setup()
    const source = new Y.Doc()
    const updates: Uint8Array[] = []
    source.on('update', (update: Uint8Array) => updates.push(update))
    source.getText('document-content').insert(0, 'first')
    source.getText('document-content').insert(5, ' second')
    const persistedAt = '2026-01-02T00:00:00.000Z'

    const result = repository.appendUpdates(documentId, updates, persistedAt)

    expect(result).toEqual({ revision: 1, updatedAt: persistedAt })
    expect(database!.prepare('SELECT y_revision, updated_at FROM documents WHERE id = ?').get(documentId)).toEqual({
      y_revision: 1,
      updated_at: persistedAt,
    })
    const rows = database!.prepare('SELECT revision, "update" FROM document_updates WHERE document_id = ?').all(documentId) as Array<{ revision: number; update: Buffer }>
    expect(rows).toHaveLength(1)
    expect(rows[0].revision).toBe(1)
    expect(textFrom(new Uint8Array(rows[0].update))).toBe('first second')
  })

  it('loads the snapshot plus ordered updates and rejects gaps or inconsistent revisions', () => {
    const repository = setup()
    repository.appendUpdates(documentId, [updateFor('recovered')], '2026-01-02T00:00:00.000Z')
    expect(textFrom(repository.get(documentId)!.state)).toBe('recovered')

    database!.prepare('UPDATE document_updates SET revision = 2 WHERE document_id = ?').run(documentId)
    expect(() => repository.get(documentId)).toThrow(/revision/i)
    database!.prepare('UPDATE documents SET y_revision = 3 WHERE id = ?').run(documentId)
    expect(() => repository.get(documentId)).toThrow(/revision/i)
  })

  it('compacts snapshot and log transactionally without changing updatedAt', () => {
    const repository = setup()
    const persistedAt = '2026-01-02T00:00:00.000Z'
    repository.appendUpdates(documentId, [updateFor('compact me')], persistedAt)

    expect(repository.compact(documentId)).toBe(true)
    expect(database!.prepare('SELECT y_revision, y_snapshot_revision, updated_at FROM documents WHERE id = ?').get(documentId)).toEqual({
      y_revision: 1,
      y_snapshot_revision: 1,
      updated_at: persistedAt,
    })
    expect(database!.prepare('SELECT count(*) FROM document_updates WHERE document_id = ?').pluck().get(documentId)).toBe(0)
    expect(textFrom(repository.get(documentId)!.state)).toBe('compact me')
  })

  it('cascades update log rows when deleting a document', () => {
    const repository = setup()
    repository.appendUpdates(documentId, [updateFor('delete me')], '2026-01-02T00:00:00.000Z')
    repository.delete(documentId)
    expect(database!.prepare('SELECT count(*) FROM document_updates').pluck().get()).toBe(0)
  })

  it('rolls back the log insert when advancing the document revision fails', () => {
    const repository = setup()
    database!.exec(`
      CREATE TRIGGER reject_revision BEFORE UPDATE OF y_revision ON documents
      BEGIN SELECT RAISE(ABORT, 'revision rejected'); END;
    `)
    expect(() => repository.appendUpdates(documentId, [updateFor('atomic')], createdAt)).toThrow()
    expect(database!.prepare('SELECT count(*) FROM document_updates').pluck().get()).toBe(0)
    expect(database!.prepare('SELECT y_revision FROM documents WHERE id = ?').pluck().get(documentId)).toBe(0)
  })
})
