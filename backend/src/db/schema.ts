import type Database from 'better-sqlite3'

export const initializeSchema = (database: Database.Database): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      state BLOB NOT NULL
    )
  `)
}
