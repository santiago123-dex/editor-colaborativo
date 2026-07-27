import { useEffect, useRef, useState } from 'react'

type CopyState = 'idle' | 'copied' | 'error'

export function ShareDocumentButton() {
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mountedRef = useRef(false)
  const operationRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current += 1
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  async function copyLink() {
    const operation = ++operationRef.current
    if (timerRef.current) clearTimeout(timerRef.current)
    try {
      const canonicalUrl = new URL(window.location.pathname, window.location.origin).href
      await navigator.clipboard.writeText(canonicalUrl)
      if (!mountedRef.current || operationRef.current !== operation) return
      setCopyState('copied')
      timerRef.current = setTimeout(() => {
        if (!mountedRef.current || operationRef.current !== operation) return
        setCopyState('idle')
        timerRef.current = undefined
      }, 2500)
    } catch {
      if (!mountedRef.current || operationRef.current !== operation) return
      setCopyState('error')
    }
  }

  return (
    <div className="share-document">
      <button
        className="header-action"
        type="button"
        aria-label="Copiar enlace del documento"
        onClick={() => void copyLink()}
      >
        Compartir
      </button>
      {copyState === 'copied' && <span className="share-document__feedback" role="status" aria-live="polite">Enlace copiado</span>}
      {copyState === 'error' && (
        <span className="share-document__feedback share-document__feedback--error" role="alert">
          No se pudo copiar el enlace.{' '}
          <button type="button" onClick={() => void copyLink()}>Reintentar copia</button>
        </span>
      )}
    </div>
  )
}
