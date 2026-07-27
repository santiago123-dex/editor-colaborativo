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

  if (!columns.some(({ name }) => name === 'owner_user_id')) {
    database.exec('ALTER TABLE documents ADD COLUMN owner_user_id TEXT')
  }

  if (!columns.some(({ name }) => name === 'owner_session_id')) {
    database.exec('ALTER TABLE documents ADD COLUMN owner_session_id TEXT')
  }

  if (!columns.some(({ name }) => name === 'y_revision')) {
    database.exec('ALTER TABLE documents ADD COLUMN y_revision INTEGER NOT NULL DEFAULT 0')
  }

  if (!columns.some(({ name }) => name === 'y_snapshot_revision')) {
    database.exec('ALTER TABLE documents ADD COLUMN y_snapshot_revision INTEGER NOT NULL DEFAULT 0')
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

  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash BLOB NOT NULL,
      password_salt BLOB NOT NULL,
      created_at TEXT NOT NULL
    )
  `)

  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      user_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `)

  database.exec('CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions(token_hash)')
  database.exec('CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at)')

  database.exec(`
    CREATE TABLE IF NOT EXISTS document_updates (
      document_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      "update" BLOB NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (document_id, revision),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    ) WITHOUT ROWID
  `)
}
