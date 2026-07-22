import Database from 'better-sqlite3'

export const createDatabase = (path: string): Database.Database => {
  const database = new Database(path)
  database.pragma('journal_mode = WAL')
  return database
}
