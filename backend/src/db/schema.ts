import type Database from 'better-sqlite3'

export const initializeSchema = (database: Database.Database): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      state BLOB NOT NULL
    )
  `)

  const columns = database.pragma('table_info(documents)') as Array<{ name: string }>
  if (!columns.some(({ name }) => name === 'updated_at')) {
    // Inspect the actual schema because legacy databases may have an unreliable user_version.
    database.transaction(() => {
      database.exec("ALTER TABLE documents ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''")
      database.exec('UPDATE documents SET updated_at = created_at')
    })()
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      UNIQUE (document_id, client_message_id)
    );

    CREATE INDEX IF NOT EXISTS messages_document_created_id_idx
      ON messages (document_id, created_at DESC, id DESC);
  `)
}
