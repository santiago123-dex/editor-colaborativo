import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import * as Y from 'yjs'
import { DOCUMENT_TEXT, UUID_PATTERN } from '../constants.js'
import type { DocumentRepository } from '../db/document-repository.js'

export const createDocumentsRouter = (
  repository: DocumentRepository,
  getActiveDocument: (documentId: string) => Y.Doc | undefined,
): Router => {
  const router = Router()

  router.post('/', (_request, response) => {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    repository.create(id, createdAt)
    response.status(201).json({ id, createdAt })
  })

  router.get('/', (_request, response) => {
    response.json(repository.list())
  })

  router.get('/:id', (request, response) => {
    if (!UUID_PATTERN.test(request.params.id)) {
      response.status(404).json({ error: 'Document not found' })
      return
    }

    const stored = repository.get(request.params.id)
    if (!stored) {
      response.status(404).json({ error: 'Document not found' })
      return
    }

    const activeDocument = getActiveDocument(stored.id)
    const doc = activeDocument ?? new Y.Doc()
    if (!activeDocument) Y.applyUpdate(doc, stored.state)

    response.json({
      id: stored.id,
      content: doc.getText(DOCUMENT_TEXT).toString(),
      createdAt: stored.createdAt,
    })

    if (!activeDocument) doc.destroy()
  })

  return router
}
