import Database from 'better-sqlite3'

export const createDatabase = (path: string): Database.Database => {
  const database = new Database(path)
  database.pragma('foreign_keys = ON')
  database.pragma('journal_mode = WAL')
  database.pragma('busy_timeout = 2000')
  return database
}
