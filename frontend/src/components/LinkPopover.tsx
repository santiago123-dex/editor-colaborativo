import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Editor } from '@tiptap/react'

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

export function LinkPopover({
  editor,
  linkButtonRef,
  onClose,
}: {
  editor: Editor
  linkButtonRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const [linkHref, setLinkHref] = useState(() => {
    if (editor.isActive('link')) return String(editor.getAttributes('link').href ?? '')
    return ''
  })
  const [linkError, setLinkError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const linkActive = editor.isActive('link')

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function closeLinkForm() {
    setLinkError(false)
    linkButtonRef.current?.focus()
    onClose()
  }

  function saveLink(event: FormEvent) {
    event.preventDefault()
    const href = normalizeLinkHref(linkHref)
    if (!href) {
      setLinkError(true)
      return
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
    closeLinkForm()
  }

  return (
    <form
      id="editor-link-form"
      className="link-popover"
      aria-label="Editar enlace"
      onSubmit={saveLink}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeLinkForm()
        }
      }}
    >
      <label htmlFor="editor-link-url">URL del enlace</label>
      <input
        ref={inputRef}
        id="editor-link-url"
        type="text"
        inputMode="url"
        autoComplete="url"
        value={linkHref}
        aria-invalid={linkError}
        aria-describedby={linkError ? 'editor-link-error' : undefined}
        onChange={(event) => {
          setLinkHref(event.target.value)
          setLinkError(false)
        }}
      />
      {linkError && (
        <span id="editor-link-error" className="link-popover__error" role="alert">
          Ingresá una URL http, https o mailto válida
        </span>
      )}
      <div className="link-popover__actions">
        {linkActive && (
          <button
            type="button"
            onClick={() => {
              editor.chain().focus().unsetLink().run()
              closeLinkForm()
            }}
          >Quitar enlace</button>
        )}
        <button type="button" onClick={closeLinkForm}>Cancelar</button>
        <button type="submit">Aplicar</button>
      </div>
    </form>
  )
}
