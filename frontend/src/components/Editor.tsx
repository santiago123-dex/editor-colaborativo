import Collaboration from '@tiptap/extension-collaboration'
import Placeholder from '@tiptap/extension-placeholder'
import { EditorContent, useEditor, type Editor as TiptapEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { getDocument, updateDocumentTitle } from '../api/documents'
import { ChatPanel } from './ChatPanel'

interface EditorProps {
  documentId: string
  onBack: () => void
}

interface CollaborationSession {
  document: Y.Doc
  provider: WebsocketProvider
}

type ConnectionState = 'loading' | 'connecting' | 'synchronizing' | 'ready' | 'reconnecting' | 'offline'
type TitleSaveState = 'idle' | 'saving' | 'saved' | 'error'

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  loading: 'Validando',
  connecting: 'Conectando',
  synchronizing: 'Sincronizando',
  ready: 'Listo',
  reconnecting: 'Reconectando',
  offline: 'Sin conexión',
}

const TITLE_SAVE_LABELS: Record<TitleSaveState, string> = {
  idle: 'Título sin cambios',
  saving: 'Guardando título…',
  saved: 'Título actualizado',
  error: 'Error al guardar título',
}

const WEBSOCKET_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:3000/ws'

interface ToolbarButtonProps {
  label: string
  title: string
  children: ReactNode
  active?: boolean
  disabled?: boolean
  onClick: () => void
}

function ToolbarButton({ label, title, children, active, disabled, onClick }: ToolbarButtonProps) {
  return (
    <button
      className="toolbar__button"
      type="button"
      aria-label={label}
      aria-pressed={active ?? false}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function EditorToolbar({ editor }: { editor: TiptapEditor }) {
  return (
    <div className="toolbar" role="toolbar" aria-label="Formato de texto">
      <div className="toolbar__group" aria-label="Tipo de bloque">
        <ToolbarButton
          label="Párrafo"
          title="Párrafo"
          active={editor.isActive('paragraph')}
          disabled={!editor.can().chain().focus().setParagraph().run()}
          onClick={() => editor.chain().focus().setParagraph().run()}
        >P</ToolbarButton>
        <ToolbarButton
          label="Título nivel 1"
          title="Título 1"
          active={editor.isActive('heading', { level: 1 })}
          disabled={!editor.can().chain().focus().toggleHeading({ level: 1 }).run()}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        >H1</ToolbarButton>
        <ToolbarButton
          label="Título nivel 2"
          title="Título 2"
          active={editor.isActive('heading', { level: 2 })}
          disabled={!editor.can().chain().focus().toggleHeading({ level: 2 }).run()}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >H2</ToolbarButton>
      </div>
      <div className="toolbar__group" aria-label="Énfasis">
        <ToolbarButton
          label="Negrita"
          title="Negrita (Ctrl+B)"
          active={editor.isActive('bold')}
          disabled={!editor.can().chain().focus().toggleBold().run()}
          onClick={() => editor.chain().focus().toggleBold().run()}
        ><strong>B</strong></ToolbarButton>
        <ToolbarButton
          label="Cursiva"
          title="Cursiva (Ctrl+I)"
          active={editor.isActive('italic')}
          disabled={!editor.can().chain().focus().toggleItalic().run()}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        ><em>I</em></ToolbarButton>
        <ToolbarButton
          label="Tachado"
          title="Tachado (Ctrl+Shift+S)"
          active={editor.isActive('strike')}
          disabled={!editor.can().chain().focus().toggleStrike().run()}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        ><s>S</s></ToolbarButton>
      </div>
      <div className="toolbar__group" aria-label="Estructura">
        <ToolbarButton
          label="Lista con viñetas"
          title="Lista con viñetas (Ctrl+Shift+8)"
          active={editor.isActive('bulletList')}
          disabled={!editor.can().chain().focus().toggleBulletList().run()}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >• Lista</ToolbarButton>
        <ToolbarButton
          label="Lista numerada"
          title="Lista numerada (Ctrl+Shift+7)"
          active={editor.isActive('orderedList')}
          disabled={!editor.can().chain().focus().toggleOrderedList().run()}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >1. Lista</ToolbarButton>
        <ToolbarButton
          label="Cita"
          title="Cita (Ctrl+Shift+B)"
          active={editor.isActive('blockquote')}
          disabled={!editor.can().chain().focus().toggleBlockquote().run()}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >“ Cita</ToolbarButton>
        <ToolbarButton
          label="Bloque de código"
          title="Bloque de código (Ctrl+Alt+C)"
          active={editor.isActive('codeBlock')}
          disabled={!editor.can().chain().focus().toggleCodeBlock().run()}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        >{'</>'}</ToolbarButton>
      </div>
      <div className="toolbar__group toolbar__group--history" aria-label="Historial">
        <ToolbarButton
          label="Deshacer"
          title="Deshacer (Ctrl+Z)"
          disabled={!editor.can().chain().focus().undo().run()}
          onClick={() => editor.chain().focus().undo().run()}
        >↶</ToolbarButton>
        <ToolbarButton
          label="Rehacer"
          title="Rehacer (Ctrl+Shift+Z)"
          disabled={!editor.can().chain().focus().redo().run()}
          onClick={() => editor.chain().focus().redo().run()}
        >↷</ToolbarButton>
      </div>
    </div>
  )
}

function CollaborativeTextEditor({ document }: { document: Y.Doc }) {
  const editor = useEditor({
    shouldRerenderOnTransaction: true,
    extensions: [
      // Collaboration owns undo history, so StarterKit must not create a competing history.
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document }),
      Placeholder.configure({ placeholder: 'Empezá a escribir…' }),
    ],
    editorProps: {
      attributes: {
        class: 'editor-surface',
        'aria-label': 'Área de edición',
      },
    },
  }, [document])

  if (!editor) return <p className="message">Preparando editor…</p>

  return (
    <>
      <EditorToolbar editor={editor} />
      <div className="paper">
        <EditorContent editor={editor} />
      </div>
    </>
  )
}

export function Editor({ documentId, onBack }: EditorProps) {
  const [session, setSession] = useState<CollaborationSession | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>('loading')
  const [title, setTitle] = useState('')
  const [savedTitle, setSavedTitle] = useState('')
  const [loadedDocumentId, setLoadedDocumentId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [titleError, setTitleError] = useState<string | null>(null)
  const [titleSaveState, setTitleSaveState] = useState<TitleSaveState>('idle')
  const [chatOpen, setChatOpen] = useState(false)
  const [unreadMessages, setUnreadMessages] = useState(0)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const chatToggleRef = useRef<HTMLButtonElement>(null)
  const mountedRef = useRef(true)
  const currentDocumentIdRef = useRef(documentId)
  const saveSequenceRef = useRef(0)
  const pendingTitleRef = useRef<string | null>(null)
  const titleRef = useRef('')

  useEffect(() => {
    const controller = new AbortController()
    mountedRef.current = true
    currentDocumentIdRef.current = documentId
    saveSequenceRef.current += 1
    pendingTitleRef.current = null
    setLoadedDocumentId(null)
    setConnectionState('loading')
    setLoadError(null)
    setTitleError(null)
    setTitleSaveState('idle')
    setChatOpen(false)
    setUnreadMessages(0)

    getDocument(documentId, controller.signal)
      .then((document) => {
        if (controller.signal.aborted) return
        titleRef.current = document.title
        setTitle(document.title)
        setSavedTitle(document.title)
        setLoadedDocumentId(documentId)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setLoadError(error instanceof Error ? error.message : 'Ocurrió un error inesperado')
      })

    return () => {
      controller.abort()
      mountedRef.current = false
    }
  }, [documentId])

  useEffect(() => {
    if (loadedDocumentId === documentId && title === '') titleInputRef.current?.focus()
  }, [documentId, loadedDocumentId, title])

  useEffect(() => {
    if (loadedDocumentId !== documentId) {
      setSession(null)
      return
    }

    const document = new Y.Doc()
    const provider = new WebsocketProvider(WEBSOCKET_URL, documentId, document)
    let hasConnected = false
    let isConnected = false

    setConnectionState('connecting')
    const handleStatus = ({ status }: { status: string }) => {
      if (status === 'connected') {
        hasConnected = true
        isConnected = true
        setConnectionState('synchronizing')
      } else if (status === 'connecting') {
        isConnected = false
        setConnectionState(hasConnected ? 'reconnecting' : 'connecting')
      } else if (status === 'disconnected') {
        isConnected = false
        setConnectionState(hasConnected ? 'reconnecting' : 'offline')
      }
    }
    const handleConnectionError = () => {
      isConnected = false
      setConnectionState('offline')
    }
    const handleSynced = (synced: boolean) => {
      if (synced) setConnectionState('ready')
      else if (isConnected) setConnectionState('synchronizing')
    }

    provider.on('status', handleStatus)
    provider.on('connection-error', handleConnectionError)
    provider.on('synced', handleSynced)
    setSession({ document, provider })

    return () => {
      provider.off('status', handleStatus)
      provider.off('connection-error', handleConnectionError)
      provider.off('synced', handleSynced)
      provider.destroy()
      document.destroy()
    }
  }, [documentId, loadedDocumentId])

  async function saveTitle() {
    if (loadedDocumentId !== documentId || title === savedTitle || pendingTitleRef.current === title) return

    const titleToSave = title
    const saveDocumentId = documentId
    const saveSequence = ++saveSequenceRef.current
    pendingTitleRef.current = titleToSave
    setTitleError(null)
    setTitleSaveState('saving')

    try {
      const updatedDocument = await updateDocumentTitle(saveDocumentId, titleToSave)
      if (
        !mountedRef.current ||
        currentDocumentIdRef.current !== saveDocumentId ||
        saveSequenceRef.current !== saveSequence
      ) return
      pendingTitleRef.current = null
      setSavedTitle(updatedDocument.title)
      if (titleRef.current === titleToSave) {
        titleRef.current = updatedDocument.title
        setTitle(updatedDocument.title)
        setTitleSaveState('saved')
      }
    } catch (error) {
      if (
        !mountedRef.current ||
        currentDocumentIdRef.current !== saveDocumentId ||
        saveSequenceRef.current !== saveSequence
      ) return
      pendingTitleRef.current = null
      setTitleError(error instanceof Error ? error.message : 'Ocurrió un error inesperado')
      setTitleSaveState('error')
    }
  }

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
            disabled={loadedDocumentId !== documentId || !session}
            onChange={(event) => {
              titleRef.current = event.target.value
              setTitle(event.target.value)
              setTitleSaveState('idle')
              setTitleError(null)
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
          <div className={`connection connection--${connectionState}`} role="status" aria-label="Estado de sincronización">
            <span className="connection__dot" aria-hidden="true" />
            {CONNECTION_LABELS[connectionState]}
          </div>
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
              <CollaborativeTextEditor document={session.document} />
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
