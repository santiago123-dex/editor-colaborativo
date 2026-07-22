import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import * as Y from 'yjs'
import { DOCUMENT_TEXT, TIPTAP_FRAGMENT, UUID_PATTERN } from '../constants.js'
import type { DocumentRepository } from '../db/document-repository.js'

export const createDocumentsRouter = (
  repository: DocumentRepository,
  getActiveDocument: (documentId: string) => Y.Doc | undefined,
  isDocumentActive: (documentId: string) => boolean,
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
    const tiptapContent = doc.getXmlFragment(TIPTAP_FRAGMENT)
    const legacyContent = doc.getText(DOCUMENT_TEXT)
    if (!activeDocument) Y.applyUpdate(doc, stored.state)
    // Tiptap Collaboration stores ProseMirror content in "default"; the named Y.Text remains for existing clients.
    const content = tiptapContent.length > 0 ? tiptapContent.toString() : legacyContent.toString()

    response.json({
      id: stored.id,
      title: stored.title,
      content,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    })

    if (!activeDocument) doc.destroy()
  })

  router.patch('/:id', (request, response) => {
    if (!UUID_PATTERN.test(request.params.id)) {
      response.status(404).json({ error: 'Document not found' })
      return
    }

    const stored = repository.get(request.params.id)
    if (!stored) {
      response.status(404).json({ error: 'Document not found' })
      return
    }

    if (typeof request.body?.title !== 'string') {
      response.status(400).json({ error: 'Invalid title' })
      return
    }

    const title = request.body.title.trim()
    if (title.length > 100) {
      response.status(400).json({ error: 'Invalid title' })
      return
    }

    const updatedAt = new Date().toISOString()
    repository.updateTitle(stored.id, title, updatedAt)
    response.json({ id: stored.id, title, createdAt: stored.createdAt, updatedAt })
  })

  router.delete('/:id', (request, response) => {
    if (!UUID_PATTERN.test(request.params.id)) {
      response.status(404).json({ error: 'Document not found' })
      return
    }

    if (isDocumentActive(request.params.id)) {
      response.status(409).json({ error: 'Document is active' })
      return
    }

    if (!repository.delete(request.params.id)) {
      response.status(404).json({ error: 'Document not found' })
      return
    }

    response.status(204).end()
  })

  return router
}
