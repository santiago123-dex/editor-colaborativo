import { createCollaborationServer } from './server.js'

const port = Number(process.env.PORT ?? 3000)
const databasePath = process.env.DATABASE_PATH ?? 'editor-colaborativo.sqlite'
const backend = createCollaborationServer({ databasePath })

backend.httpServer.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`)
})

const shutdown = async () => {
  await backend.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
