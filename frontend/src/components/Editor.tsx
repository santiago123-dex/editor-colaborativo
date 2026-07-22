import Collaboration from '@tiptap/extension-collaboration'
import Placeholder from '@tiptap/extension-placeholder'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useState } from 'react'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'

interface EditorProps {
  documentId: string
  onBack: () => void
}

interface CollaborationSession {
  document: Y.Doc
  provider: WebsocketProvider
}

const WEBSOCKET_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:3000/ws'

function CollaborativeTextEditor({ document }: { document: Y.Doc }) {
  const editor = useEditor({
    extensions: [
      // Yjs owns undo history in collaborative mode, so StarterKit must not create another one.
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document }),
      // Placeholder adds an empty-only class, so the hint disappears as soon as text exists.
      Placeholder.configure({ placeholder: 'Empezá a escribir…' }),
    ],
    editorProps: {
      attributes: {
        class: 'editor-surface',
        'aria-label': 'Área de edición',
      },
    },
  }, [document])

  return <EditorContent editor={editor} />
}

export function Editor({ documentId, onBack }: EditorProps) {
  const [session, setSession] = useState<CollaborationSession | null>(null)
  const [isConnected, setIsConnected] = useState(false)

  useEffect(() => {
    const document = new Y.Doc()
    // y-websocket appends the room ID, producing /ws/:documentId as required by the backend.
    const provider = new WebsocketProvider(WEBSOCKET_URL, documentId, document)
    const handleStatus = ({ status }: { status: string }) => {
      setIsConnected(status === 'connected')
    }

    provider.on('status', handleStatus)
    setSession({ document, provider })

    return () => {
      provider.off('status', handleStatus)
      provider.destroy()
      document.destroy()
    }
  }, [documentId])

  return (
    <main className="editor-page">
      <header className="editor-header">
        <button className="back-button" type="button" onClick={onBack}>
          <span aria-hidden="true">←</span> Documentos
        </button>
        <div className="editor-header__identity">
          <span className="editor-header__title">Documento sin título</span>
          <span className="editor-header__id">{documentId}</span>
        </div>
        <div className={`connection ${isConnected ? 'connection--online' : ''}`} role="status">
          <span className="connection__dot" aria-hidden="true" />
          {isConnected ? 'Conectado' : 'Desconectado'}
        </div>
      </header>

      <section className="editor-workspace">
        <div className="paper">
          {session ? (
            <CollaborativeTextEditor document={session.document} />
          ) : (
            <p className="message">Preparando editor…</p>
          )}
        </div>
      </section>
    </main>
  )
}
