import { useEffect, useRef, useState } from 'react'
import { getDocument, updateDocumentTitle } from '../api/documents'
import { useAuthSession } from '../auth/AuthSessionContext'

export type DocumentLoaderState = 'loading' | 'ready' | 'error'

export interface DocumentLoaderResult {
  title: string
  setTitle: (title: string) => void
  savedTitle: string
  loadedDocumentId: string | null
  loadError: string | null
  titleError: string | null
  titleSaveState: 'idle' | 'saving' | 'saved' | 'error'
  saveTitle: () => Promise<void>
}

export function useDocumentLoader(documentId: string): DocumentLoaderResult {
  const { status: sessionStatus } = useAuthSession()
  const [title, setTitle] = useState('')
  const [savedTitle, setSavedTitle] = useState('')
  const [loadedDocumentId, setLoadedDocumentId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [titleError, setTitleError] = useState<string | null>(null)
  const [titleSaveState, setTitleSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
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
    setLoadError(null)
    setTitleError(null)
    setTitleSaveState('idle')

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

  async function saveTitle() {
    if (
      sessionStatus !== 'ready' ||
      loadedDocumentId !== documentId ||
      title === savedTitle ||
      pendingTitleRef.current === title
    ) return

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

  function handleSetTitle(value: string) {
    titleRef.current = value
    setTitle(value)
  }

  return {
    title,
    setTitle: handleSetTitle,
    savedTitle,
    loadedDocumentId,
    loadError,
    titleError,
    titleSaveState,
    saveTitle,
  }
}
