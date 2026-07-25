import CharacterCount from '@tiptap/extension-character-count'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import { useAuthSession } from '../auth/AuthSessionContext'
import { useDocumentLoader } from '../hooks/useDocumentLoader'
import { useCollaborationSession } from '../collaboration/useCollaborationSession'
import { createPresenceIdentity } from '../collaboration/presenceIdentity'
import { AuthControls } from './AuthControls'
import { ChatPanel } from './ChatPanel'
import { EditorToolbar } from './EditorToolbar'
import { Participants } from './Participants'
import { ShareDocumentButton } from './ShareDocumentButton'
import { WordCount } from './WordCount'

interface EditorProps {
  documentId: string
  onBack: () => void
}

const CONNECTION_LABELS: Record<string, string> = {
  loading: 'Validando',
  connecting: 'Conectando',
  synchronizing: 'Sincronizando',
  ready: 'Listo',
  reconnecting: 'Reconectando',
  offline: 'Sin conexión',
}

const TITLE_SAVE_LABELS: Record<string, string> = {
  idle: 'Título sin cambios',
  saving: 'Guardando título…',
  saved: 'Título actualizado',
  error: 'Error al guardar título',
}

const PERSISTENCE_LABELS: Record<string, string> = {
  unchanged: 'Sin cambios',
  pending: 'Cambios pendientes',
  saving: 'Guardando contenido…',
  saved: 'Guardado',
  error: 'No se pudo guardar',
}

function normalizeLinkHref(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || /[\u0000-\u001F\u007F]/.test(trimmed)) return null

  const scheme = trimmed.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase()
  if (scheme && !['http', 'https', 'mailto'].includes(scheme)) return null
  const href = scheme ? trimmed : `https://${trimmed}`

  try {
    const url = new URL(href)
    if (url.protocol === 'mailto:') {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url.pathname) ? href : null
    }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
      return null
    }
    return href
  } catch {
    return null
  }
}

function CollaborativeTextEditor({ session }: { session: import('../collaboration/useCollaborationSession').CollaborationSession }) {
  const editor = useEditor({
    shouldRerenderOnTransaction: true,
    extensions: [
      StarterKit.configure({ undoRedo: false, link: false }),
      Collaboration.configure({ document: session.document }),
      CollaborationCaret.configure({ provider: session.provider, user: session.identity }),
      Placeholder.configure({ placeholder: 'Empezá a escribir…' }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        protocols: ['http', 'https', 'mailto'],
        isAllowedUri: (url) => normalizeLinkHref(url) !== null,
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      CharacterCount,
    ],
    editorProps: {
      attributes: {
        class: 'editor-surface',
        'aria-label': 'Área de edición',
      },
    },
  }, [session])

  if (!editor) return <p className="message">Preparando editor…</p>

  return (
    <>
      <EditorToolbar editor={editor} />
      <div className="paper">
        <EditorContent editor={editor} />
        <WordCount editor={editor} />
      </div>
    </>
  )
}

export function Editor({ documentId, onBack }: EditorProps) {
  const { status: sessionStatus, session: authSession } = useAuthSession()
  const {
    title, setTitle, savedTitle, loadedDocumentId,
    loadError, titleError, titleSaveState, saveTitle,
  } = useDocumentLoader(documentId)
  const { session, connectionState, persistenceState } = useCollaborationSession(documentId, loadedDocumentId)
  const [chatOpen, setChatOpen] = useState(false)
  const [unreadMessages, setUnreadMessages] = useState(0)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const chatToggleRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (loadedDocumentId === documentId && title === '') titleInputRef.current?.focus()
  }, [documentId, loadedDocumentId, title])

  useEffect(() => {
    if (!session) return
    session.provider.awareness.setLocalStateField(
      'user',
      createPresenceIdentity(authSession?.user?.email),
    )
  }, [authSession?.user?.email, session])

  return (
    <main className="editor-page">
      <header className="editor-header">
        <button className="back-button" type="button" onClick={onBack}>
          <span aria-hidden="true">←</span> Documentos
        </button>
        <div className="editor-header__identity">
          <input
            ref={titleInputRef}
            className="editor-header__title"
            type="text"
            aria-label="Título del documento"
            maxLength={100}
            placeholder="Documento sin título"
            value={title}
            disabled={loadedDocumentId !== documentId || !session || sessionStatus !== 'ready'}
            onChange={(event) => {
              setTitle(event.target.value)
            }}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.blur()
                void saveTitle()
              }
            }}
          />
          <span className="editor-header__title-meta">
            <span
              className={`title-save-state title-save-state--${titleSaveState}`}
              role="status"
              aria-live="polite"
              aria-label="Estado del título"
            >
              {TITLE_SAVE_LABELS[titleSaveState]}
            </span>
            {title.length >= 80 && (
              <span className="title-counter" aria-label={`${title.length} de 100 caracteres`}>
                {title.length}/100
              </span>
            )}
          </span>
        </div>
        <div className="editor-header__actions">
          {session && <Participants awareness={session.provider.awareness} />}
          <div className={`connection connection--${connectionState}`} role="status" aria-label="Estado de sincronización">
            <span className="connection__dot" aria-hidden="true" />
            {CONNECTION_LABELS[connectionState]}
          </div>
          <div className={`persistence persistence--${persistenceState.status}`} role="status" aria-live="polite" aria-label="Persistencia del contenido">
            {PERSISTENCE_LABELS[persistenceState.status]}
            {persistenceState.status === 'error' && persistenceState.retryable && session && (
              <button type="button" onClick={() => session.durability.retry()}>Reintentar</button>
            )}
          </div>
          <ShareDocumentButton />
          <button
            ref={chatToggleRef}
            className="chat-toggle"
            type="button"
            aria-label={chatOpen ? 'Ocultar chat' : 'Abrir chat'}
            aria-expanded={chatOpen}
            aria-controls="document-chat"
            onClick={() => {
              setChatOpen((open) => !open)
              setUnreadMessages(0)
            }}
          >
            Chat
            {unreadMessages > 0 && (
              <span className="chat-toggle__badge" aria-label={`${unreadMessages} mensajes sin leer`}>
                {unreadMessages > 99 ? '99+' : unreadMessages}
              </span>
            )}
          </button>
          <AuthControls />
        </div>
      </header>

      {loadError ? (
        <section className="editor-state editor-state--error" role="alert">
          <p className="eyebrow">NO PUDIMOS ABRIR EL DOCUMENTO</p>
          <h2>El editor no está disponible</h2>
          <p>{loadError}</p>
          <button className="primary-button" type="button" onClick={onBack} autoFocus>
            Volver a documentos
          </button>
        </section>
      ) : loadedDocumentId !== documentId || !session ? (
        <section
          className="editor-state"
          role="status"
          aria-label={loadedDocumentId === documentId ? 'Preparando editor' : 'Cargando documento'}
        >
          <span className="editor-state__mark" aria-hidden="true">Aa</span>
          <h2>{loadedDocumentId === documentId ? 'Preparando editor…' : 'Cargando documento…'}</h2>
          <p>
            {loadedDocumentId === documentId
              ? 'Iniciando la sesión colaborativa.'
              : 'Verificando que esté disponible antes de iniciar la edición.'}
          </p>
        </section>
      ) : (
        <>
          {titleError && (
            <div className="editor-error message message--error" role="alert">
              <span>{titleError}</span>
              <button type="button" onClick={saveTitle}>Reintentar</button>
            </div>
          )}
          <div className={`editor-layout ${chatOpen ? 'editor-layout--chat-open' : ''}`}>
            <section className="editor-workspace">
              <CollaborativeTextEditor session={session} />
            </section>
            <div id="document-chat" className="chat-drawer">
              <ChatPanel
                documentId={documentId}
                isOpen={chatOpen}
                onClose={() => {
                  setChatOpen(false)
                  chatToggleRef.current?.focus()
                }}
                onUnreadMessage={() => setUnreadMessages((count) => count + 1)}
              />
            </div>
          </div>
        </>
      )}
    </main>
  )
}
