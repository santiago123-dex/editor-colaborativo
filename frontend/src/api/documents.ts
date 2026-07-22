import { request } from './http'

export { HttpError } from './http'

export interface DocumentSummary {
  id: string
  createdAt: string
  updatedAt: string
  title: string
}

export interface DocumentDetails extends DocumentSummary {
  content: string
}

export interface CreatedDocument {
  id: string
  createdAt: string
}

export function getDocuments(signal?: AbortSignal): Promise<DocumentSummary[]> {
  return request(
    '/documents',
    'No se pudieron cargar los documentos',
    signal ? { signal } : undefined,
  )
}

export function createDocument(signal?: AbortSignal): Promise<CreatedDocument> {
  return request('/documents', 'No se pudo crear el documento', {
    method: 'POST',
    ...(signal ? { signal } : {}),
  })
}

export function getDocument(id: string, signal?: AbortSignal): Promise<DocumentDetails> {
  return request(
    `/documents/${encodeURIComponent(id)}`,
    'No se pudieron cargar los datos del documento',
    signal ? { signal } : undefined,
  )
}

export function updateDocumentTitle(
  id: string,
  title: string,
  signal?: AbortSignal,
): Promise<DocumentSummary> {
  return request(
    `/documents/${encodeURIComponent(id)}`,
    'No se pudo guardar el título. Intentá nuevamente',
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
      ...(signal ? { signal } : {}),
    },
  )
}

export function deleteDocument(id: string, signal?: AbortSignal): Promise<void> {
  return request(
    `/documents/${encodeURIComponent(id)}`,
    'No se pudo eliminar el documento. Intentá nuevamente',
    { method: 'DELETE', ...(signal ? { signal } : {}) },
    false,
  )
}
