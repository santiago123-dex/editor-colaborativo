import { useEffect, useState } from 'react'
import { DocumentList } from './components/DocumentList'
import { Editor } from './components/Editor'

function getDocumentIdFromPath(): string | null {
  const match = window.location.pathname.match(/^\/documents\/([^/]+)\/?$/)
  return match ? decodeURIComponent(match[1]) : null
}

export default function App() {
  const [documentId, setDocumentId] = useState(getDocumentIdFromPath)

  useEffect(() => {
    // popstate keeps browser Back and Forward navigation in sync without a routing dependency.
    const handleHistoryChange = () => setDocumentId(getDocumentIdFromPath())
    window.addEventListener('popstate', handleHistoryChange)
    return () => window.removeEventListener('popstate', handleHistoryChange)
  }, [])

  function openDocument(id: string) {
    window.history.pushState({}, '', `/documents/${encodeURIComponent(id)}`)
    setDocumentId(id)
  }

  function showDocumentList() {
    window.history.pushState({}, '', '/')
    setDocumentId(null)
  }

  return documentId ? (
    <Editor documentId={documentId} onBack={showDocumentList} />
  ) : (
    <DocumentList onOpenDocument={openDocument} />
  )
}
