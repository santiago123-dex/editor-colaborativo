import { useEffect, useState } from 'react'
import {
  createDocument,
  getDocuments,
  type DocumentSummary,
} from '../api/documents'

interface DocumentListProps {
  onOpenDocument: (documentId: string) => void
}

export function DocumentList({ onOpenDocument }: DocumentListProps) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isCurrent = true

    getDocuments()
      .then((loadedDocuments) => {
        if (isCurrent) setDocuments(loadedDocuments)
      })
      .catch((loadError: unknown) => {
        if (isCurrent) {
          setError(loadError instanceof Error ? loadError.message : 'Ocurrió un error inesperado')
        }
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false)
      })

    // Ignore a request that finishes after navigating away from this screen.
    return () => {
      isCurrent = false
    }
  }, [])

  async function handleCreateDocument() {
    setIsCreating(true)
    setError(null)

    try {
      const document = await createDocument()
      onOpenDocument(document.id)
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : 'Ocurrió un error inesperado',
      )
      setIsCreating(false)
    }
  }

  return (
    <main className="document-list">
      <header className="document-list__header">
        <div>
          <p className="eyebrow">ESPACIO DE TRABAJO</p>
          <h1>Documentos</h1>
          <p className="subtitle">Creá una idea y escribila en equipo, en tiempo real.</p>
        </div>
        <button
          className="primary-button"
          type="button"
          onClick={handleCreateDocument}
          disabled={isCreating}
        >
          {isCreating ? 'Creando…' : 'Nuevo documento'}
        </button>
      </header>

      {error && <p className="message message--error" role="alert">{error}</p>}
      {isLoading && <p className="message">Cargando documentos…</p>}

      {!isLoading && documents.length === 0 && (
        <section className="empty-state">
          <span className="empty-state__mark" aria-hidden="true">Aa</span>
          <h2>Todavía no hay documentos</h2>
          <p>Creá el primero para empezar a colaborar.</p>
        </section>
      )}

      {!isLoading && documents.length > 0 && (
        <section className="document-grid" aria-label="Documentos existentes">
          {documents.map((document) => {
            const title = document.title.trim() || 'Documento sin título'

            return (
              <button
                className="document-card"
                type="button"
                key={document.id}
                onClick={() => onOpenDocument(document.id)}
                aria-label={`Abrir ${title}`}
              >
                <span className="document-card__icon" aria-hidden="true">¶</span>
                <span className="document-card__content">
                  <strong>{title}</strong>
                  <time dateTime={document.createdAt}>
                    {new Intl.DateTimeFormat('es-AR', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(document.createdAt))}
                  </time>
                </span>
                <span className="document-card__arrow" aria-hidden="true">→</span>
              </button>
            )
          })}
        </section>
      )}
    </main>
  )
}
