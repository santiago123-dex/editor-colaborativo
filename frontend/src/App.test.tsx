import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import App from './App'

vi.mock('./components/DocumentList', () => ({
  DocumentList: ({ onOpenDocument }: { onOpenDocument: (id: string) => void }) => (
    <button onClick={() => onOpenDocument('doc-1')}>Abrir documento</button>
  ),
}))

vi.mock('./components/Editor', () => ({
  Editor: ({ documentId, onBack }: { documentId: string; onBack: () => void }) => (
    <div>
      <span>Editor {documentId}</span>
      <button onClick={onBack}>Volver</button>
    </div>
  ),
}))

describe('App routing', () => {
  beforeEach(() => window.history.replaceState({}, '', '/'))

  it('navigates between the list and a document using browser URLs', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /abrir documento/i }))
    expect(screen.getByText('Editor doc-1')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/documents/doc-1')

    fireEvent.click(screen.getByRole('button', { name: /volver/i }))
    expect(window.location.pathname).toBe('/')
  })
})
