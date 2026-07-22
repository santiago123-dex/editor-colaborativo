import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { createDocument, getDocuments } from '../api/documents'
import { DocumentList } from './DocumentList'

vi.mock('../api/documents', () => ({
  createDocument: vi.fn(),
  getDocuments: vi.fn(),
}))

const mockedGetDocuments = vi.mocked(getDocuments)
const mockedCreateDocument = vi.mocked(createDocument)

describe('DocumentList', () => {
  it('shows existing documents and opens the selected one', async () => {
    const onOpenDocument = vi.fn()
    mockedGetDocuments.mockResolvedValue([
      { id: 'doc-1', title: 'Plan semanal', createdAt: '2026-07-22T10:00:00.000Z' },
    ])

    render(<DocumentList onOpenDocument={onOpenDocument} />)

    expect(await screen.findByText('Plan semanal')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /plan semanal/i }))
    expect(onOpenDocument).toHaveBeenCalledWith('doc-1')
  })

  it('creates a document and opens it', async () => {
    mockedGetDocuments.mockResolvedValue([])
    mockedCreateDocument.mockResolvedValue({
      id: 'doc-new',
      createdAt: '2026-07-22T10:00:00.000Z',
    })
    const onOpenDocument = vi.fn()

    render(<DocumentList onOpenDocument={onOpenDocument} />)
    fireEvent.click(await screen.findByRole('button', { name: /nuevo documento/i }))

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith('doc-new'))
  })

  it('shows an empty state when there are no documents', async () => {
    mockedGetDocuments.mockResolvedValue([])

    render(<DocumentList onOpenDocument={vi.fn()} />)

    expect(await screen.findByText(/todavía no hay documentos/i)).toBeInTheDocument()
  })
})
