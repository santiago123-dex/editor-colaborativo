import { useRef, useState, type ReactNode } from 'react'
import type { Editor as TiptapEditor } from '@tiptap/react'
import { LinkPopover } from './LinkPopover'

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

export function EditorToolbar({ editor }: { editor: TiptapEditor }) {
  const [linkOpen, setLinkOpen] = useState(false)
  const linkButtonRef = useRef<HTMLButtonElement>(null)
  const linkActive = editor.isActive('link')

  return (
    <>
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
          label="Lista de tareas"
          title="Lista de tareas"
          active={editor.isActive('taskList')}
          disabled={!editor.can().chain().focus().toggleTaskList().run()}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
        >☐ Tareas</ToolbarButton>
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
        <div className="toolbar__group toolbar__group--link" aria-label="Enlace">
        <button
          ref={linkButtonRef}
          className="toolbar__button"
          type="button"
          aria-label={linkActive ? 'Editar enlace' : 'Agregar enlace'}
          aria-pressed={linkActive}
          aria-expanded={linkOpen}
          aria-controls="editor-link-form"
          title={linkActive ? 'Editar enlace' : 'Agregar enlace'}
          onClick={() => setLinkOpen((open) => !open)}
        >Enlace</button>
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
      {linkOpen && (
        <LinkPopover
          editor={editor}
          linkButtonRef={linkButtonRef}
          onClose={() => setLinkOpen(false)}
        />
      )}
    </>
  )
}
