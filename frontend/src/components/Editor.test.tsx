import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { getDocument, updateDocumentTitle } from '../api/documents'
import { Editor } from './Editor'

type StatusHandler = (event: { status: string }) => void
type ErrorHandler = () => void
type SyncedHandler = (synced: boolean) => void
type WebsocketHandler = StatusHandler | ErrorHandler | SyncedHandler

const websocketMock = vi.hoisted(() => ({
  args: [] as unknown[],
  create: vi.fn(),
  destroy: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  statusHandler: (() => {}) as StatusHandler,
  errorHandler: (() => {}) as ErrorHandler,
  syncedHandler: (() => {}) as SyncedHandler,
}))

const placeholderMock = vi.hoisted(() => ({ configure: vi.fn(() => ({})) }))
const useEditorMock = vi.hoisted(() => ({ options: {} as Record<string, unknown> }))

vi.mock('../api/documents', () => ({
  getDocument: vi.fn(),
  updateDocumentTitle: vi.fn(),
}))

vi.mock('y-websocket', () => ({
  WebsocketProvider: class {
    constructor(...args: unknown[]) {
      websocketMock.args = args
      websocketMock.create(...args)
    }

    on(event: string, handler: WebsocketHandler) {
      websocketMock.on(event, handler)
      if (event === 'status') websocketMock.statusHandler = handler as StatusHandler
      if (event === 'connection-error') websocketMock.errorHandler = handler as ErrorHandler
      if (event === 'synced') websocketMock.syncedHandler = handler as SyncedHandler
    }

    off(event: string, handler: WebsocketHandler) {
      websocketMock.off(event, handler)
    }

    destroy() {
      websocketMock.destroy()
    }
  },
}))

const editorMock = vi.hoisted(() => {
  const chain = {
    focus: vi.fn(), toggleHeading: vi.fn(), setParagraph: vi.fn(), toggleBold: vi.fn(),
    toggleItalic: vi.fn(), toggleStrike: vi.fn(), toggleBulletList: vi.fn(),
    toggleOrderedList: vi.fn(), toggleBlockquote: vi.fn(), toggleCodeBlock: vi.fn(),
    undo: vi.fn(), redo: vi.fn(), run: vi.fn(() => true),
  }
  Object.values(chain).forEach((method) => {
    if (method !== chain.run) method.mockReturnValue(chain)
  })
  return {
    commandChain: chain,
    chain: vi.fn(() => chain),
    can: vi.fn(() => ({ chain: () => chain })),
    isActive: vi.fn(() => false),
  }
})

vi.mock('@tiptap/react', () => ({
  useEditor: (options: Record<string, unknown>) => {
    useEditorMock.options = options
    return editorMock
  },
  EditorContent: () => <div aria-label="Área de edición" />,
}))

vi.mock('@tiptap/starter-kit', () => ({
  default: { configure: () => ({}) },
}))

vi.mock('@tiptap/extension-collaboration', () => ({
  default: { configure: () => ({}) },
}))

vi.mock('@tiptap/extension-placeholder', () => ({
  default: { configure: placeholderMock.configure },
}))

vi.mock('./ChatPanel', () => ({
  ChatPanel: ({ documentId, isOpen, onClose, onUnreadMessage }: {
    documentId: string
    isOpen: boolean
    onClose: () => void
    onUnreadMessage: () => void
  }) => (
    <aside aria-label="Chat del documento" data-document-id={documentId} hidden={!isOpen}>
      <button type="button" onClick={onClose}>Cerrar chat</button>
      <button type="button" onClick={onUnreadMessage}>Simular mensaje</button>
    </aside>
  ),
}))

const mockedGetDocument = vi.mocked(getDocument)
const mockedUpdateDocumentTitle = vi.mocked(updateDocumentTitle)
const loadedDocument = {
  id: 'doc-42',
  title: 'Mi documento',
  content: '',
  createdAt: '2026-07-22T10:00:00.000Z',
  updatedAt: '2026-07-22T11:00:00.000Z',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}

describe('Editor', () => {
  beforeEach(() => {
    editorMock.chain.mockReturnValue(editorMock.commandChain)
    editorMock.can.mockReturnValue({ chain: () => editorMock.commandChain })
    Object.values(editorMock.commandChain).forEach((method) => {
      if (method !== editorMock.commandChain.run) method.mockReturnValue(editorMock.commandChain)
    })
    editorMock.commandChain.run.mockReturnValue(true)
    editorMock.isActive.mockReturnValue(false)
    mockedGetDocument.mockResolvedValue(loadedDocument)
  })

  it('loads the title and saves it on blur using the normalized response', async () => {
    mockedUpdateDocumentTitle.mockResolvedValue({
      ...loadedDocument,
      title: 'Título normalizado',
      updatedAt: '2026-07-22T12:00:00.000Z',
    })
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)

    const title = await screen.findByRole('textbox', { name: /título del documento/i })
    expect(title).toHaveValue('Mi documento')
    expect(title).toHaveAttribute('maxlength', '100')

    fireEvent.change(title, { target: { value: '  Título normalizado  ' } })
    fireEvent.blur(title)

    await waitFor(() => expect(mockedUpdateDocumentTitle).toHaveBeenCalledWith(
      'doc-42',
      '  Título normalizado  ',
    ))
    expect(title).toHaveValue('Título normalizado')
  })

  it('moves focus on Enter so blur performs a single save', async () => {
    mockedUpdateDocumentTitle.mockResolvedValue({ ...loadedDocument, title: 'Nuevo' })
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    const title = await screen.findByRole('textbox', { name: /título del documento/i })

    title.focus()
    fireEvent.change(title, { target: { value: 'Nuevo' } })
    fireEvent.keyDown(title, { key: 'Enter' })

    await waitFor(() => expect(mockedUpdateDocumentTitle).toHaveBeenCalledTimes(1))
  })

  it('shows an empty title through its placeholder and avoids unchanged PATCH requests', async () => {
    mockedGetDocument.mockResolvedValue({ ...loadedDocument, title: '' })
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    const title = await screen.findByRole('textbox', { name: /título del documento/i })

    expect(title).toHaveAttribute('placeholder', 'Documento sin título')
    fireEvent.blur(title)
    expect(mockedUpdateDocumentTitle).not.toHaveBeenCalled()
  })

  it('keeps the editor mounted and reports title save errors', async () => {
    mockedUpdateDocumentTitle.mockRejectedValue(new Error('No se pudo guardar el título'))
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    const title = await screen.findByRole('textbox', { name: /título del documento/i })

    fireEvent.change(title, { target: { value: 'Nuevo título' } })
    fireEvent.blur(title)

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo guardar el título')
    expect(screen.getByLabelText('Área de edición')).toBeInTheDocument()
  })

  it('retries a failed title save with the current value', async () => {
    mockedUpdateDocumentTitle
      .mockRejectedValueOnce(new Error('No se pudo guardar el título'))
      .mockResolvedValueOnce({ ...loadedDocument, title: 'Título recuperado' })
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    const title = await screen.findByRole('textbox', { name: /título del documento/i })

    fireEvent.change(title, { target: { value: 'Título recuperado' } })
    fireEvent.blur(title)
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }))

    await waitFor(() => expect(mockedUpdateDocumentTitle).toHaveBeenCalledTimes(2))
    expect(mockedUpdateDocumentTitle).toHaveBeenLastCalledWith('doc-42', 'Título recuperado')
  })

  it('shows a discreet title counter only near the limit', async () => {
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    const title = await screen.findByRole('textbox', { name: /título del documento/i })

    expect(screen.queryByText(/\/100$/)).not.toBeInTheDocument()
    fireEvent.change(title, { target: { value: 'a'.repeat(95) } })

    expect(screen.getByText('95/100')).toBeInTheDocument()
  })

  it('waits for valid metadata before creating the collaborative session', async () => {
    const metadata = deferred<typeof loadedDocument>()
    mockedGetDocument.mockReturnValue(metadata.promise)
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)

    expect(screen.getByRole('status', { name: /cargando documento/i })).toBeInTheDocument()
    expect(websocketMock.create).not.toHaveBeenCalled()

    await act(async () => metadata.resolve(loadedDocument))

    await waitFor(() => expect(websocketMock.create).toHaveBeenCalledTimes(1))
    expect(screen.getByLabelText('Área de edición')).toBeInTheDocument()
  })

  it('shows an actionable error and never opens a WebSocket when metadata fails', async () => {
    const onBack = vi.fn()
    mockedGetDocument.mockRejectedValue(new Error('El documento no existe'))
    render(<Editor documentId="missing" onBack={onBack} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('El documento no existe')
    expect(websocketMock.create).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /volver a documentos/i }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('ignores metadata that arrives after unmount', async () => {
    let resolveDocument!: (document: typeof loadedDocument) => void
    mockedGetDocument.mockReturnValue(new Promise((resolve) => { resolveDocument = resolve }))
    const { unmount } = render(<Editor documentId="doc-42" onBack={vi.fn()} />)

    unmount()
    await act(async () => resolveDocument(loadedDocument))

    expect(mockedUpdateDocumentTitle).not.toHaveBeenCalled()
  })

  it('ignores stale metadata when the document changes before the previous GET resolves', async () => {
    const firstDocument = deferred<typeof loadedDocument>()
    const secondDocument = deferred<typeof loadedDocument>()
    mockedGetDocument.mockImplementation((id) => (
      id === 'doc-a' ? firstDocument.promise : secondDocument.promise
    ))
    const { rerender } = render(<Editor documentId="doc-a" onBack={vi.fn()} />)

    rerender(<Editor documentId="doc-b" onBack={vi.fn()} />)
    await act(async () => secondDocument.resolve({
      ...loadedDocument,
      id: 'doc-b',
      title: 'Documento B',
    }))
    expect(screen.getByRole('textbox', { name: /título del documento/i })).toHaveValue('Documento B')

    await act(async () => firstDocument.resolve({
      ...loadedDocument,
      id: 'doc-a',
      title: 'Documento A demorado',
    }))
    expect(screen.getByRole('textbox', { name: /título del documento/i })).toHaveValue('Documento B')
  })

  it('destroys the previous collaborative session when the document ID changes', async () => {
    mockedGetDocument.mockImplementation(async (id) => ({
      ...loadedDocument,
      id,
      title: `Documento ${id}`,
    }))
    const { rerender } = render(<Editor documentId="doc-a" onBack={vi.fn()} />)
    await waitFor(() => expect(websocketMock.create).toHaveBeenCalledTimes(1))

    rerender(<Editor documentId="doc-b" onBack={vi.fn()} />)

    await waitFor(() => expect(websocketMock.create).toHaveBeenCalledTimes(2))
    expect(websocketMock.destroy).toHaveBeenCalledTimes(1)
    expect(websocketMock.args[1]).toBe('doc-b')
  })

  it('ignores an older PATCH response that resolves after a newer save', async () => {
    const firstSave = deferred<typeof loadedDocument>()
    const secondSave = deferred<typeof loadedDocument>()
    mockedUpdateDocumentTitle
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise)
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    const title = await screen.findByRole('textbox', { name: /título del documento/i })

    fireEvent.change(title, { target: { value: 'Primera edición' } })
    fireEvent.blur(title)
    fireEvent.change(title, { target: { value: 'Segunda edición' } })
    fireEvent.blur(title)

    await act(async () => secondSave.resolve({ ...loadedDocument, title: 'Segunda edición' }))
    await act(async () => firstSave.resolve({ ...loadedDocument, title: 'Primera edición' }))

    expect(title).toHaveValue('Segunda edición')
  })

  it('does not overwrite a newer local edit when the pending PATCH resolves', async () => {
    const firstSave = deferred<typeof loadedDocument>()
    mockedUpdateDocumentTitle.mockReturnValue(firstSave.promise)
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    const title = await screen.findByRole('textbox', { name: /título del documento/i })

    fireEvent.change(title, { target: { value: 'Edición A' } })
    fireEvent.blur(title)
    fireEvent.change(title, { target: { value: 'Edición B local' } })

    await act(async () => firstSave.resolve({ ...loadedDocument, title: 'Edición A normalizada' }))

    expect(title).toHaveValue('Edición B local')
  })

  it('ignores a PATCH response from the previous document', async () => {
    const firstSave = deferred<typeof loadedDocument>()
    mockedUpdateDocumentTitle.mockReturnValue(firstSave.promise)
    mockedGetDocument.mockImplementation(async (id) => ({
      ...loadedDocument,
      id,
      title: id === 'doc-a' ? 'Documento A' : 'Documento B',
    }))
    const { rerender } = render(<Editor documentId="doc-a" onBack={vi.fn()} />)
    const title = await screen.findByRole('textbox', { name: /título del documento/i })

    fireEvent.change(title, { target: { value: 'Edición de A' } })
    fireEvent.blur(title)
    rerender(<Editor documentId="doc-b" onBack={vi.fn()} />)
    await waitFor(() => expect(title).toHaveValue('Documento B'))

    await act(async () => firstSave.resolve({
      ...loadedDocument,
      id: 'doc-a',
      title: 'Edición de A normalizada',
    }))
    expect(title).toHaveValue('Documento B')
  })

  it('rerenders toolbar state on Tiptap transactions', async () => {
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: /título del documento/i })).toBeEnabled())

    expect(useEditorMock.options).toMatchObject({ shouldRerenderOnTransaction: true })
  })

  it('integrates chat without replacing the collaborative editor', async () => {
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)

    const chat = await screen.findByLabelText('Chat del documento')
    expect(chat)
      .toHaveAttribute('data-document-id', 'doc-42')
    expect(chat).not.toBeVisible()
    expect(screen.getByLabelText('Área de edición')).toBeInTheDocument()
  })

  it('opens and closes chat without unmounting it and clears the unread badge', async () => {
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    const toggle = await screen.findByRole('button', { name: 'Abrir chat' })
    const chat = await screen.findByLabelText('Chat del documento')

    fireEvent.click(screen.getByRole('button', { name: 'Simular mensaje', hidden: true }))
    expect(toggle).toHaveTextContent('1')
    fireEvent.click(toggle)
    expect(chat).toBeVisible()
    expect(screen.getByRole('button', { name: 'Cerrar chat' })).toBeInTheDocument()
    expect(toggle).not.toHaveTextContent('1')

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar chat' }))
    expect(chat).not.toBeVisible()
    expect(toggle).toHaveFocus()
  })

  it('reports connection status and cleans every WebSocket listener', async () => {
    const { unmount } = render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: /título del documento/i })).toBeEnabled())

    expect(websocketMock.args[0]).toEqual(expect.stringMatching(/^wss?:\/\/.*\/ws$/))
    expect(websocketMock.args[1]).toBe('doc-42')
    expect(placeholderMock.configure).toHaveBeenCalledWith({ placeholder: 'Empezá a escribir…' })
    expect(screen.getByText('Conectando')).toBeInTheDocument()

    act(() => websocketMock.statusHandler({ status: 'connected' }))
    expect(screen.getByText('Sincronizando')).toBeInTheDocument()

    act(() => websocketMock.syncedHandler(true))
    expect(screen.getByText('Listo')).toBeInTheDocument()

    act(() => websocketMock.statusHandler({ status: 'disconnected' }))
    expect(screen.getByText('Reconectando')).toBeInTheDocument()

    act(() => websocketMock.statusHandler({ status: 'connecting' }))
    expect(screen.getByText('Reconectando')).toBeInTheDocument()

    act(() => websocketMock.errorHandler())
    expect(screen.getByText('Sin conexión')).toBeInTheDocument()

    const statusHandler = websocketMock.statusHandler
    const errorHandler = websocketMock.errorHandler
    const syncedHandler = websocketMock.syncedHandler
    unmount()
    expect(websocketMock.off).toHaveBeenCalledWith('status', statusHandler)
    expect(websocketMock.off).toHaveBeenCalledWith('connection-error', errorHandler)
    expect(websocketMock.off).toHaveBeenCalledWith('synced', syncedHandler)
    expect(websocketMock.destroy).toHaveBeenCalled()
  })

  it('reports an initial disconnection as offline before ever connecting', async () => {
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: /título del documento/i })).toBeEnabled())

    act(() => websocketMock.statusHandler({ status: 'disconnected' }))

    expect(screen.getByText('Sin conexión')).toBeInTheDocument()
  })

})
