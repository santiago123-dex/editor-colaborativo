import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import * as Y from 'yjs'
import { DOCUMENT_TEXT, TIPTAP_FRAGMENT, UUID_PATTERN } from '../constants.js'
import type { DocumentRepository } from '../db/document-repository.js'
import type { MessageRepository } from '../db/message-repository.js'
import type { AuthRequest } from '../auth/http.js'

interface Session {
  id: string
  user: { id: string; email: string } | null
  rawToken: string
}

const canDelete = (stored: { ownerUserId: string | null; ownerSessionId: string | null }, session: Session | undefined): boolean => {
  if (!session) return false
  if (session.user && session.user.id === stored.ownerUserId) return true
  if (stored.ownerSessionId === session.id) return true
  return false
}

export const createDocumentsRouter = (
  repository: DocumentRepository,
  messageRepository: MessageRepository,
  getActiveDocument: (documentId: string) => Y.Doc | undefined,
  isDocumentActive: (documentId: string) => boolean,
  getSession?: (request: AuthRequest) => Session | undefined,
): Router => {
  const router = Router()

  router.post('/', (request, response) => {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    if (getSession) {
      const session = getSession(request)
      repository.create(id, createdAt, session?.user?.id ?? null, session?.id ?? null)
    } else {
      repository.create(id, createdAt)
    }
    response.status(201).json({ id, createdAt })
  })

  router.get('/', (request, response) => {
    const documents = repository.list()
    if (getSession) {
      const session = getSession(request)
      response.json(documents.map((doc) => ({ ...doc, canDelete: canDelete(doc, session) })))
    } else {
      response.json(documents.map(({ ownerUserId, ownerSessionId, ...rest }) => rest))
    }
  })

  router.get('/:id/messages', (request, response) => {
    if (!UUID_PATTERN.test(request.params.id) || !repository.get(request.params.id)) {
      response.status(404).json({ error: 'Document not found' })
      return
    }

    const rawLimit = request.query.limit
    if (
      rawLimit !== undefined &&
      (typeof rawLimit !== 'string' || !/^[1-9][0-9]?$/.test(rawLimit) || Number(rawLimit) > 50)
    ) {
      response.status(400).json({ error: 'Invalid limit' })
      return
    }

    response.json(messageRepository.listRecent(request.params.id, rawLimit === undefined ? 50 : Number(rawLimit)))
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
    const content = tiptapContent.length > 0 ? tiptapContent.toString() : legacyContent.toString()

    response.json({
      id: stored.id,
      title: stored.title,
      content,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      ...(getSession ? { canDelete: canDelete(stored, getSession(request)) } : {}),
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
    response.json({
      id: stored.id,
      title,
      createdAt: stored.createdAt,
      updatedAt,
      ...(getSession ? { canDelete: canDelete(stored, getSession(request)) } : {}),
    })
  })

  router.delete('/:id', (request, response) => {
    if (!UUID_PATTERN.test(request.params.id)) {
      response.status(404).json({ error: 'Document not found' })
      return
    }

    const stored = repository.get(request.params.id)
    if (!stored) {
      response.status(404).json({ error: 'Document not found' })
      return
    }

    if (getSession) {
      const session = getSession(request)
      if (!canDelete(stored, session)) {
        response.status(403).json({ error: 'Forbidden', code: 'DOCUMENT_FORBIDDEN' })
        return
      }
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
