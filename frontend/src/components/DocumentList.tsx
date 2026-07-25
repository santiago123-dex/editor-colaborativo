import { useEffect, useRef, useState } from 'react'
import {
  createDocument,
  deleteDocument,
  getDocuments,
  HttpError,
  type DocumentSummary,
} from '../api/documents'
import { useAuthSession } from '../auth/AuthSessionContext'
import { AuthControls } from './AuthControls'

interface DocumentListProps {
  onOpenDocument: (documentId: string) => void
}

type SortOption = 'updated' | 'created' | 'title'

function getDocumentTitle(document: DocumentSummary) {
  return document.title.trim() || 'Documento sin título'
}

function formatUpdatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Fecha desconocida'
  const elapsedDays = Math.floor((Date.now() - date.getTime()) / 86_400_000)

  if (elapsedDays >= 0 && elapsedDays < 7) {
    const relative = elapsedDays === 0 ? 'hoy' : elapsedDays === 1 ? 'ayer' : `hace ${elapsedDays} días`
    const time = new Intl.DateTimeFormat('es-AR', { timeStyle: 'short' }).format(date)
    return `${relative}, ${time}`
  }

  return new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function LoadingSkeleton() {
  return (
    <section className="document-skeleton" role="status" aria-label="Cargando documentos">
      <span className="sr-only">Cargando documentos…</span>
      {[1, 2, 3].map((item) => (
        <div className="document-skeleton__row" key={item} aria-hidden="true">
          <span />
          <div><strong /><small /></div>
        </div>
      ))}
    </section>
  )
}

export function DocumentList({ onOpenDocument }: DocumentListProps) {
  const { status: sessionStatus, revision: sessionRevision, retry: retrySession } = useAuthSession()
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [documentToDelete, setDocumentToDelete] = useState<DocumentSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleteConflict, setDeleteConflict] = useState<DocumentSummary | null>(null)
  const [canRetryLoad, setCanRetryLoad] = useState(false)
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortOption>('updated')
  const [reloadKey, setReloadKey] = useState(0)
  const cancelDeleteRef = useRef<HTMLButtonElement>(null)
  const deleteTriggerRef = useRef<HTMLButtonElement>(null)
  const deletionPendingRef = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    setIsLoading(true)
    setError(null)
    setDeleteConflict(null)
    setCanRetryLoad(false)

    getDocuments(controller.signal)
      .then(setDocuments)
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) return
        setError(loadError instanceof Error ? loadError.message : 'Ocurrió un error inesperado')
        setCanRetryLoad(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false)
      })

    return () => controller.abort()
  }, [reloadKey, sessionRevision])

  useEffect(() => {
    if (documentToDelete) cancelDeleteRef.current?.focus()
  }, [documentToDelete])

  const visibleDocuments = documents
    .filter((document) => getDocumentTitle(document).toLocaleLowerCase('es-AR').includes(
      query.trim().toLocaleLowerCase('es-AR'),
    ))
    .sort((left, right) => {
      if (sortBy === 'title') {
        return getDocumentTitle(left).localeCompare(getDocumentTitle(right), 'es-AR')
      }
      const field = sortBy === 'created' ? 'createdAt' : 'updatedAt'
      return new Date(right[field]).getTime() - new Date(left[field]).getTime()
    })

  async function handleCreateDocument() {
    if (sessionStatus !== 'ready') return
    setIsCreating(true)
    setError(null)
    setCanRetryLoad(false)
    try {
      const document = await createDocument()
      onOpenDocument(document.id)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Ocurrió un error inesperado')
      setIsCreating(false)
    }
  }

  async function handleDeleteDocument(document: DocumentSummary) {
    if (deletionPendingRef.current) return
    deletionPendingRef.current = true
    setDeletingId(document.id)
    closeDeleteDialog()
    setError(null)
    setDeleteConflict(null)
    setCanRetryLoad(false)

    try {
      await deleteDocument(document.id)
      setDocuments((current) => current.filter((item) => item.id !== document.id))
    } catch (deleteError) {
      if (deleteError instanceof HttpError && deleteError.status === 409) {
        setError('El documento sigue abierto en alguna sesión. Cerrá las pestañas o sesiones que lo tengan abierto y volvé a intentar.')
        setDeleteConflict(document)
      } else if (deleteError instanceof HttpError && deleteError.status === 404) {
        setError('El documento ya no existe. Recargá la lista para actualizarla.')
      } else if (deleteError instanceof HttpError && deleteError.status === 403) {
        setError('Ya no tenés permiso para eliminar este documento. La lista puede haber cambiado con tu sesión.')
      } else {
        setError(deleteError instanceof Error ? deleteError.message : 'Ocurrió un error inesperado')
      }
    } finally {
      deletionPendingRef.current = false
      setDeletingId(null)
    }
  }

  function closeDeleteDialog() {
    setDocumentToDelete(null)
    deleteTriggerRef.current?.focus()
  }

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeDeleteDialog()
      return
    }
    if (event.key !== 'Tab') return

    const cancelButton = cancelDeleteRef.current
    const deleteButton = event.currentTarget.querySelector<HTMLButtonElement>('.danger-button')
    if (!cancelButton || !deleteButton) return
    if (!event.shiftKey && document.activeElement === deleteButton) {
      event.preventDefault()
      cancelButton.focus()
    } else if (event.shiftKey && document.activeElement === cancelButton) {
      event.preventDefault()
      deleteButton.focus()
    }
  }

  return (
    <main className="document-list">
      <div className="document-list__auth"><AuthControls /></div>
      <header className="document-list__header">
        <div>
          <p className="eyebrow">ESPACIO DE TRABAJO</p>
          <h1>Documentos</h1>
          <p className="subtitle">Creá una idea y escribila en equipo, en tiempo real.</p>
        </div>
        <div className="create-document-action">
        <button className="primary-button" type="button" onClick={handleCreateDocument} disabled={isCreating || sessionStatus !== 'ready'}>
          {isCreating ? 'Creando…' : 'Nuevo documento'}
        </button>
        {sessionStatus !== 'ready' && (
          <p className="mutation-status" role="status">
            {sessionStatus === 'loading' ? 'Esperando que la sesión esté lista.' : 'La sesión no está disponible.'}
            {sessionStatus === 'error' && <button type="button" onClick={retrySession}>Reintentar sesión</button>}
          </p>
        )}
        </div>
      </header>

      {error && (
        <div className="message message--error list-error" role="alert">
          <span>{error}</span>
          {canRetryLoad && (
            <button type="button" onClick={() => setReloadKey((key) => key + 1)}>Reintentar</button>
          )}
          {deleteConflict && (
            <button
              type="button"
              onClick={() => {
                setError(null)
                setDeleteConflict(null)
                setDocumentToDelete(deleteConflict)
              }}
            >
              Reintentar eliminación
            </button>
          )}
        </div>
      )}

      {isLoading ? <LoadingSkeleton /> : (
        <>
          {documents.length > 0 && (
            <section className="document-controls" aria-label="Buscar y ordenar documentos">
              <label className="search-control">
                <span>Buscar por título</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Buscar documentos…"
                />
              </label>
              <label className="sort-control">
                <span>Ordenar documentos</span>
                <select value={sortBy} onChange={(event) => setSortBy(event.target.value as SortOption)}>
                  <option value="updated">Última edición</option>
                  <option value="created">Más recientes</option>
                  <option value="title">Nombre A–Z</option>
                </select>
              </label>
            </section>
          )}

          {documents.length === 0 && !error && (
            <section className="empty-state">
              <span className="empty-state__mark" aria-hidden="true">Aa</span>
              <h2>Todavía no hay documentos</h2>
              <p>Creá el primero para empezar a colaborar.</p>
            </section>
          )}

          {documents.length > 0 && visibleDocuments.length === 0 && (
            <section className="empty-state empty-state--search">
              <h2>No encontramos documentos</h2>
              <p>Probá con otro título o limpiá la búsqueda.</p>
              <button className="secondary-button" type="button" onClick={() => setQuery('')}>
                Limpiar búsqueda
              </button>
            </section>
          )}

          {visibleDocuments.length > 0 && (
            <section className="document-grid" aria-label="Documentos existentes">
              {visibleDocuments.map((document) => {
                const title = getDocumentTitle(document)
                const isDeleting = deletingId === document.id
                const updatedAt = new Date(document.updatedAt)
                const hasValidUpdatedAt = !Number.isNaN(updatedAt.getTime())
                return (
                  <article className="document-card" key={document.id}>
                    <button
                      className="document-card__open"
                      type="button"
                      onClick={() => onOpenDocument(document.id)}
                      aria-label={`Abrir ${title}`}
                      disabled={isDeleting}
                    >
                      <span className="document-card__icon" aria-hidden="true">¶</span>
                      <span className="document-card__content">
                        <strong>{title}</strong>
                        <time
                          dateTime={hasValidUpdatedAt ? document.updatedAt : undefined}
                          title={hasValidUpdatedAt ? updatedAt.toLocaleString('es-AR') : undefined}
                        >
                          Última edición: {formatUpdatedAt(document.updatedAt)}
                        </time>
                      </span>
                      <span className="document-card__arrow" aria-hidden="true">→</span>
                    </button>
                    {document.canDelete && <button
                      className="document-card__delete"
                      type="button"
                      onClick={(event) => {
                        if (deletionPendingRef.current) return
                        deleteTriggerRef.current = event.currentTarget
                        setDocumentToDelete(document)
                      }}
                      aria-label={isDeleting ? `Eliminando ${title}` : `Eliminar ${title}`}
                      disabled={deletingId !== null}
                    >
                      {isDeleting ? 'Eliminando…' : 'Eliminar'}
                    </button>}
                  </article>
                )
              })}
            </section>
          )}
        </>
      )}

      {documentToDelete && (
        <div className="dialog-backdrop">
          <div
            className="delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-dialog-title"
            aria-describedby="delete-dialog-description"
            onKeyDown={handleDialogKeyDown}
          >
            <p className="eyebrow">ACCIÓN PERMANENTE</p>
            <h2 id="delete-dialog-title">Eliminar documento</h2>
            <p id="delete-dialog-description">
              ¿Querés eliminar “{getDocumentTitle(documentToDelete)}”? Esta acción no se puede deshacer.
            </p>
            <div className="delete-dialog__actions">
              <button
                ref={cancelDeleteRef}
                className="secondary-button"
                type="button"
                onClick={closeDeleteDialog}
              >
                Cancelar
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => handleDeleteDocument(documentToDelete)}
              >
                Eliminar definitivamente
              </button>
            </div>
          </div>
        </div>
      )}

    </main>
  )
}
