import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { createDocument, deleteDocument, getDocuments, HttpError } from '../api/documents'
import { useAuthSession } from '../auth/AuthSessionContext'
import { DocumentList } from './DocumentList'

vi.mock('../api/documents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/documents')>()),
  createDocument: vi.fn(),
  deleteDocument: vi.fn(),
  getDocuments: vi.fn(),
}))

vi.mock('../auth/AuthSessionContext', () => ({ useAuthSession: vi.fn() }))

const mockedGetDocuments = vi.mocked(getDocuments)
const mockedCreateDocument = vi.mocked(createDocument)
const mockedDeleteDocument = vi.mocked(deleteDocument)
const mockedUseAuthSession = vi.mocked(useAuthSession)

const document = {
  id: 'doc-1',
  title: 'Plan semanal',
  createdAt: '2026-07-20T10:00:00.000Z',
  updatedAt: '2026-07-22T10:00:00.000Z',
  canDelete: true,
}

const secondDocument = {
  id: 'doc-2',
  title: 'Acta del equipo',
  createdAt: '2026-07-21T10:00:00.000Z',
  updatedAt: '2026-07-21T12:00:00.000Z',
  canDelete: true,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('DocumentList', () => {
  beforeEach(() => {
    mockedUseAuthSession.mockReturnValue({
      status: 'ready', session: { user: null, csrfToken: 'csrf' }, revision: 1, error: null,
      login: vi.fn(), register: vi.fn(), logout: vi.fn(), retry: vi.fn(),
    })
  })

  it('only offers deletion when canDelete is true', async () => {
    mockedGetDocuments.mockResolvedValue([document, { ...secondDocument, canDelete: false }])

    render(<DocumentList onOpenDocument={vi.fn()} />)

    expect(await screen.findByRole('button', { name: /eliminar plan semanal/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /eliminar acta del equipo/i })).not.toBeInTheDocument()
  })

  it('reloads the list when the accepted session revision changes', async () => {
    mockedGetDocuments.mockResolvedValue([document])
    const view = render(<DocumentList onOpenDocument={vi.fn()} />)
    await screen.findByText('Plan semanal')

    mockedUseAuthSession.mockReturnValue({
      status: 'ready', session: { user: null, csrfToken: 'csrf' }, revision: 2, error: null,
      login: vi.fn(), register: vi.fn(), logout: vi.fn(), retry: vi.fn(),
    })
    view.rerender(<DocumentList onOpenDocument={vi.fn()} />)

    await waitFor(() => expect(mockedGetDocuments).toHaveBeenCalledTimes(2))
  })

  it('disables creation while the session is loading and explains why', async () => {
    mockedUseAuthSession.mockReturnValue({
      status: 'loading', session: null, revision: 0, error: null,
      login: vi.fn(), register: vi.fn(), logout: vi.fn(), retry: vi.fn(),
    })
    mockedGetDocuments.mockResolvedValue([])

    render(<DocumentList onOpenDocument={vi.fn()} />)

    expect(await screen.findByRole('button', { name: /nuevo documento/i })).toBeDisabled()
    expect(screen.getByText(/sesión.*lista/i)).toBeInTheDocument()
  })

  it('offers a session retry when creation is unavailable after bootstrap error', async () => {
    const user = userEvent.setup()
    const retry = vi.fn()
    mockedUseAuthSession.mockReturnValue({
      status: 'error', session: null, revision: 0, error: 'Sin backend',
      login: vi.fn(), register: vi.fn(), logout: vi.fn(), retry,
    })
    mockedGetDocuments.mockResolvedValue([])
    render(<DocumentList onOpenDocument={vi.fn()} />)

    const retryButtons = await screen.findAllByRole('button', { name: /reintentar sesión/i })
    await user.click(retryButtons[0])
    expect(retry).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /nuevo documento/i })).toBeDisabled()
  })

  it('shows existing documents and opens the selected one', async () => {
    const user = userEvent.setup()
    const onOpenDocument = vi.fn()
    mockedGetDocuments.mockResolvedValue([document])

    render(<DocumentList onOpenDocument={onOpenDocument} />)

    expect(await screen.findByText('Plan semanal')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /abrir plan semanal/i }))
    expect(onOpenDocument).toHaveBeenCalledWith('doc-1')
    expect(screen.getByText(/^última edición:/i).closest('time')).toHaveAttribute(
      'datetime',
      document.updatedAt,
    )
  })

  it('renders an accessible fallback when the update date is invalid', async () => {
    mockedGetDocuments.mockResolvedValue([{ ...document, updatedAt: 'not-a-date' }])

    expect(() => render(<DocumentList onOpenDocument={vi.fn()} />)).not.toThrow()
    expect(await screen.findByText('Última edición: Fecha desconocida')).toBeInTheDocument()
    expect(screen.queryByTitle('Invalid Date')).not.toBeInTheDocument()
  })

  it('renders open and delete as separate accessible buttons', async () => {
    mockedGetDocuments.mockResolvedValue([document])

    render(<DocumentList onOpenDocument={vi.fn()} />)

    const openButton = await screen.findByRole('button', { name: /abrir plan semanal/i })
    const deleteButton = screen.getByRole('button', { name: /eliminar plan semanal/i })
    expect(openButton).not.toContainElement(deleteButton)
    expect(deleteButton).not.toContainElement(openButton)
  })

  it('opens an accessible confirmation dialog and cancels without deleting', async () => {
    const user = userEvent.setup()
    mockedGetDocuments.mockResolvedValue([document])

    render(<DocumentList onOpenDocument={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /eliminar plan semanal/i }))

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Plan semanal')
    expect(dialog).toHaveClass('delete-dialog')
    expect(dialog.parentElement).toHaveClass('dialog-backdrop')
    const cancelButton = within(dialog).getByRole('button', { name: /cancelar/i })
    expect(cancelButton).toHaveFocus()
    await user.click(cancelButton)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mockedDeleteDocument).not.toHaveBeenCalled()
    expect(screen.getByText('Plan semanal')).toBeInTheDocument()
  })

  it('closes the delete dialog with Escape and restores focus to its trigger', async () => {
    const user = userEvent.setup()
    mockedGetDocuments.mockResolvedValue([document])
    render(<DocumentList onOpenDocument={vi.fn()} />)
    const trigger = await screen.findByRole('button', { name: /eliminar plan semanal/i })

    await user.click(trigger)
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('traps focus between the delete dialog actions', async () => {
    const user = userEvent.setup()
    mockedGetDocuments.mockResolvedValue([document])
    render(<DocumentList onOpenDocument={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /eliminar plan semanal/i }))
    const dialog = screen.getByRole('dialog')
    const cancelButton = within(dialog).getByRole('button', { name: /cancelar/i })
    const deleteButton = within(dialog).getByRole('button', { name: /eliminar definitivamente/i })

    deleteButton.focus()
    await user.tab()
    expect(cancelButton).toHaveFocus()
    cancelButton.focus()
    await user.tab({ shift: true })
    expect(deleteButton).toHaveFocus()
  })

  it('removes a document after confirming a successful deletion', async () => {
    const user = userEvent.setup()
    mockedGetDocuments.mockResolvedValue([document])
    mockedDeleteDocument.mockResolvedValue()

    render(<DocumentList onOpenDocument={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /eliminar plan semanal/i }))
    await user.click(screen.getByRole('button', { name: /eliminar definitivamente/i }))

    await waitFor(() => expect(screen.queryByText('Plan semanal')).not.toBeInTheDocument())
    expect(mockedDeleteDocument).toHaveBeenCalledWith('doc-1')
  })

  it('keeps the document and reports a deletion error', async () => {
    const user = userEvent.setup()
    mockedGetDocuments.mockResolvedValue([document])
    mockedDeleteDocument.mockRejectedValue(new Error('No se pudo eliminar el documento'))

    render(<DocumentList onOpenDocument={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /eliminar plan semanal/i }))
    await user.click(screen.getByRole('button', { name: /eliminar definitivamente/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo eliminar el documento')
    expect(screen.queryByRole('button', { name: /reintentar/i })).not.toBeInTheDocument()
    expect(screen.getByText('Plan semanal')).toBeInTheDocument()
  })

  it('keeps the document and explains a 403 permission denial', async () => {
    const user = userEvent.setup()
    mockedGetDocuments.mockResolvedValue([document])
    mockedDeleteDocument.mockRejectedValue(new HttpError(403, 'Forbidden'))
    render(<DocumentList onOpenDocument={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: /eliminar plan semanal/i }))
    await user.click(screen.getByRole('button', { name: /eliminar definitivamente/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/permiso/i)
    expect(screen.getByText('Plan semanal')).toBeInTheDocument()
  })

  it('explains a 409 without assuming another person and offers a clear retry flow', async () => {
    const user = userEvent.setup()
    mockedGetDocuments.mockResolvedValue([document])
    mockedDeleteDocument.mockRejectedValue(new HttpError(409, 'Conflict'))

    render(<DocumentList onOpenDocument={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /eliminar plan semanal/i }))
    await user.click(screen.getByRole('button', { name: /eliminar definitivamente/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('El documento sigue abierto en alguna sesión')
    expect(alert).not.toHaveTextContent(/otra persona/i)
    await user.click(within(alert).getByRole('button', { name: /reintentar eliminación/i }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Plan semanal')
  })

  it('blocks every delete action while one deletion is pending', async () => {
    const user = userEvent.setup()
    const deletion = deferred<void>()
    mockedGetDocuments.mockResolvedValue([document, secondDocument])
    mockedDeleteDocument.mockReturnValue(deletion.promise)
    render(<DocumentList onOpenDocument={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: /eliminar plan semanal/i }))
    await user.click(screen.getByRole('button', { name: /eliminar definitivamente/i }))

    expect(screen.getByRole('button', { name: /eliminando plan semanal/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /eliminar acta del equipo/i })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /eliminar acta del equipo/i }))
    expect(mockedDeleteDocument).toHaveBeenCalledTimes(1)

    await act(async () => deletion.resolve())
  })

  it('creates a document and opens it', async () => {
    const user = userEvent.setup()
    mockedGetDocuments.mockResolvedValue([])
    mockedCreateDocument.mockResolvedValue({
      id: 'doc-new',
      createdAt: '2026-07-22T10:00:00.000Z',
    })
    const onOpenDocument = vi.fn()

    render(<DocumentList onOpenDocument={onOpenDocument} />)
    await user.click(await screen.findByRole('button', { name: /nuevo documento/i }))

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith('doc-new'))
  })

  it('does not offer a list reload retry for create errors', async () => {
    const user = userEvent.setup()
    mockedGetDocuments.mockResolvedValue([])
    mockedCreateDocument.mockRejectedValue(new Error('No se pudo crear el documento'))
    render(<DocumentList onOpenDocument={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: /nuevo documento/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo crear el documento')
    expect(screen.queryByRole('button', { name: /reintentar/i })).not.toBeInTheDocument()
  })

  it('offers retry only when loading the list fails', async () => {
    mockedGetDocuments.mockRejectedValue(new Error('No se pudieron cargar los documentos'))
    render(<DocumentList onOpenDocument={vi.fn()} />)

    expect(await screen.findByRole('button', { name: /reintentar/i })).toBeInTheDocument()
  })

  it('filters documents by title', async () => {
    const user = userEvent.setup()
    mockedGetDocuments.mockResolvedValue([document, secondDocument])
    render(<DocumentList onOpenDocument={vi.fn()} />)
    await screen.findByText('Plan semanal')

    await user.type(screen.getByRole('searchbox', { name: /buscar por título/i }), 'acta')

    expect(screen.getByText('Acta del equipo')).toBeInTheDocument()
    expect(screen.queryByText('Plan semanal')).not.toBeInTheDocument()
  })

  it('sorts documents by title', async () => {
    const user = userEvent.setup()
    mockedGetDocuments.mockResolvedValue([document, secondDocument])
    render(<DocumentList onOpenDocument={vi.fn()} />)
    await screen.findByText('Plan semanal')

    await user.selectOptions(screen.getByRole('combobox', { name: /ordenar documentos/i }), 'title')

    const cards = within(screen.getByRole('region', { name: /documentos existentes/i }))
      .getAllByRole('article')
    expect(cards.map((card) => card.querySelector('strong')?.textContent)).toEqual([
      'Acta del equipo',
      'Plan semanal',
    ])
  })

  it('shows an empty state when there are no documents', async () => {
    mockedGetDocuments.mockResolvedValue([])

    render(<DocumentList onOpenDocument={vi.fn()} />)

    expect(await screen.findByText(/todavía no hay documentos/i)).toBeInTheDocument()
  })

})
