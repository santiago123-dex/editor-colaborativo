import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as decoding from 'lib0/decoding'
import { vi } from 'vitest'
import * as Y from 'yjs'
import { getDocument, updateDocumentTitle } from '../api/documents'
import { useAuthSession } from '../auth/AuthSessionContext'
import { Editor } from './Editor'

type StatusHandler = (event: { status: string }) => void
type ErrorHandler = () => void
type SyncedHandler = (synced: boolean) => void
type WebsocketHandler = StatusHandler | ErrorHandler | SyncedHandler

const websocketMock = vi.hoisted(() => ({
  args: [] as unknown[],
  create: vi.fn(),
  connect: vi.fn(),
  destroy: vi.fn(),
  send: vi.fn(),
  setLocalState: vi.fn(),
  setLocalStateField: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  messageHandlers: [] as unknown[],
  statusHandler: (() => {}) as StatusHandler,
  errorHandler: (() => {}) as ErrorHandler,
  syncedHandler: (() => {}) as SyncedHandler,
}))

const placeholderMock = vi.hoisted(() => ({ configure: vi.fn(() => ({})) }))
const caretMock = vi.hoisted(() => ({ configure: vi.fn(() => ({})) }))
const linkMock = vi.hoisted(() => ({ configure: vi.fn(() => ({})) }))
const taskItemMock = vi.hoisted(() => ({ configure: vi.fn(() => ({})) }))
const useEditorMock = vi.hoisted(() => ({ options: {} as Record<string, unknown> }))

vi.mock('../api/documents', () => ({
  getDocument: vi.fn(),
  updateDocumentTitle: vi.fn(),
}))

vi.mock('../auth/AuthSessionContext', () => ({ useAuthSession: vi.fn() }))

vi.mock('y-websocket', () => ({
  WebsocketProvider: class {
    messageHandlers: unknown[] = []
    ws = { readyState: 1, send: websocketMock.send }
    awareness = {
      getStates: () => new Map(),
      on: vi.fn(),
      off: vi.fn(),
      setLocalState: websocketMock.setLocalState,
      setLocalStateField: websocketMock.setLocalStateField,
    }

    constructor(...args: unknown[]) {
      websocketMock.args = args
      websocketMock.messageHandlers = this.messageHandlers
      websocketMock.create(...args)
    }

    connect() {
      websocketMock.connect()
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
    extendMarkRange: vi.fn(), setLink: vi.fn(), unsetLink: vi.fn(), toggleTaskList: vi.fn(),
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
    getAttributes: vi.fn(() => ({})),
    on: vi.fn(),
    off: vi.fn(),
    storage: { characterCount: { words: vi.fn(() => 0) } },
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

vi.mock('@tiptap/extension-collaboration-caret', () => ({
  default: { configure: caretMock.configure },
}))

vi.mock('@tiptap/extension-placeholder', () => ({
  default: { configure: placeholderMock.configure },
}))

vi.mock('@tiptap/extension-link', () => ({
  default: { configure: linkMock.configure },
}))

vi.mock('@tiptap/extension-task-list', () => ({ default: {} }))

vi.mock('@tiptap/extension-task-item', () => ({
  default: { configure: taskItemMock.configure },
}))

vi.mock('@tiptap/extension-character-count', () => ({ default: {} }))

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
const mockedUseAuthSession = vi.mocked(useAuthSession)
const loadedDocument = {
  id: 'doc-42',
  title: 'Mi documento',
  content: '',
  createdAt: '2026-07-22T10:00:00.000Z',
  updatedAt: '2026-07-22T11:00:00.000Z',
  canDelete: true,
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
    mockedUseAuthSession.mockReturnValue({
      status: 'ready', session: { user: null, csrfToken: 'csrf' }, revision: 1, error: null,
      login: vi.fn(), register: vi.fn(), logout: vi.fn(), retry: vi.fn(),
    })
    editorMock.chain.mockReturnValue(editorMock.commandChain)
    editorMock.can.mockReturnValue({ chain: () => editorMock.commandChain })
    Object.values(editorMock.commandChain).forEach((method) => {
      if (method !== editorMock.commandChain.run) method.mockReturnValue(editorMock.commandChain)
    })
    editorMock.commandChain.run.mockReturnValue(true)
    editorMock.isActive.mockReturnValue(false)
    editorMock.getAttributes.mockReturnValue({})
    editorMock.storage.characterCount.words.mockReturnValue(0)
    mockedGetDocument.mockResolvedValue(loadedDocument)
  })

  it('loads collaboration while auth is loading but disables title mutation', async () => {
    mockedUseAuthSession.mockReturnValue({
      status: 'loading', session: null, revision: 0, error: null,
      login: vi.fn(), register: vi.fn(), logout: vi.fn(), retry: vi.fn(),
    })

    render(<Editor documentId="doc-42" onBack={vi.fn()} />)

    expect(await screen.findByLabelText('Área de edición')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /título del documento/i })).toBeDisabled()
    expect(websocketMock.create).toHaveBeenCalledTimes(1)
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

  it('updates presence without recreating a session or losing pending local changes when auth changes', async () => {
    const { rerender } = render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    await waitFor(() => expect(websocketMock.create).toHaveBeenCalledTimes(1))
    const document = websocketMock.args[2] as Y.Doc
    act(() => document.getText('content').insert(0, 'Pendiente'))
    expect(screen.getByRole('status', { name: 'Persistencia del contenido' })).toHaveTextContent('Cambios pendientes')

    mockedUseAuthSession.mockReturnValue({
      status: 'ready',
      session: { user: { id: 'user-1', email: 'persona@example.com' }, csrfToken: 'csrf-2' },
      revision: 2,
      error: null,
      login: vi.fn(), register: vi.fn(), logout: vi.fn(), retry: vi.fn(),
    })
    rerender(<Editor documentId="doc-42" onBack={vi.fn()} />)

    expect(websocketMock.create).toHaveBeenCalledTimes(1)
    expect(websocketMock.destroy).not.toHaveBeenCalled()
    expect(websocketMock.setLocalState).not.toHaveBeenCalledWith(null)
    expect(websocketMock.setLocalStateField).toHaveBeenLastCalledWith(
      'user',
      expect.objectContaining({ name: 'persona@example.com' }),
    )
    expect(screen.getByRole('status', { name: 'Persistencia del contenido' })).toHaveTextContent('Cambios pendientes')
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

  it('configures safe links, nested task items and collaborative word counting', async () => {
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    await screen.findByLabelText('Área de edición')

    expect(linkMock.configure).toHaveBeenCalledWith(expect.objectContaining({
      openOnClick: false,
      autolink: true,
      defaultProtocol: 'https',
      protocols: ['http', 'https', 'mailto'],
    }))
    expect(taskItemMock.configure).toHaveBeenCalledWith({ nested: true })
    expect(useEditorMock.options.extensions).toHaveLength(8)
  })

  it('creates a normalized link from an accessible popover and returns focus', async () => {
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    const trigger = await screen.findByRole('button', { name: 'Agregar enlace' })

    fireEvent.click(trigger)
    const input = screen.getByRole('textbox', { name: 'URL del enlace' })
    const popover = screen.getByRole('form', { name: 'Editar enlace' })
    expect(trigger.closest('[role="toolbar"]')).not.toContainElement(popover)
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: 'example.com/notas' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Editar enlace' }))

    expect(editorMock.commandChain.extendMarkRange).toHaveBeenCalledWith('link')
    expect(editorMock.commandChain.setLink).toHaveBeenCalledWith({ href: 'https://example.com/notas' })
    expect(screen.queryByRole('form', { name: 'Editar enlace' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('rejects unsafe link protocols without running a command', async () => {
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Agregar enlace' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'URL del enlace' }), {
      target: { value: 'javascript:alert(1)' },
    })
    fireEvent.submit(screen.getByRole('form', { name: 'Editar enlace' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Ingresá una URL http, https o mailto válida')
    expect(editorMock.commandChain.setLink).not.toHaveBeenCalled()
  })

  it('edits and removes the active link, and closes with Escape', async () => {
    editorMock.isActive.mockImplementation((name: string) => name === 'link')
    editorMock.getAttributes.mockReturnValue({ href: 'https://example.com/viejo' })
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    const trigger = await screen.findByRole('button', { name: 'Editar enlace' })

    expect(trigger).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(trigger)
    expect(screen.getByRole('textbox', { name: 'URL del enlace' })).toHaveValue('https://example.com/viejo')
    fireEvent.click(screen.getByRole('button', { name: 'Quitar enlace' }))
    expect(editorMock.commandChain.unsetLink).toHaveBeenCalled()
    expect(trigger).toHaveFocus()

    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('form', { name: 'Editar enlace' }), { key: 'Escape' })
    expect(screen.queryByRole('form', { name: 'Editar enlace' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('toggles checklist and exposes its active state', async () => {
    editorMock.isActive.mockImplementation((name: string) => name === 'taskList')
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    const button = await screen.findByRole('button', { name: 'Lista de tareas' })

    expect(button).toHaveAttribute('aria-pressed', 'true')
    editorMock.commandChain.toggleTaskList.mockClear()
    fireEvent.click(button)
    expect(editorMock.commandChain.toggleTaskList).toHaveBeenCalledTimes(1)
  })

  it('shows the current word count once without announcing every edit', async () => {
    editorMock.storage.characterCount.words.mockReturnValue(37)
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)

    const counter = await screen.findByLabelText('Contador de palabras')
    expect(counter).toHaveTextContent('37 palabras')
    expect(counter).not.toHaveAttribute('role', 'status')
    expect(counter).not.toHaveAttribute('aria-live')
    expect(editorMock.storage.characterCount.words).toHaveBeenCalledTimes(1)
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
    expect(websocketMock.args[3]).toEqual({ connect: false })
    expect(websocketMock.messageHandlers[4]).toEqual(expect.any(Function))
    expect(websocketMock.connect).toHaveBeenCalledTimes(1)
    expect(websocketMock.setLocalStateField).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({ name: expect.any(String), color: expect.stringMatching(/^#/) }),
    )
    expect(caretMock.configure).toHaveBeenCalledWith(expect.objectContaining({
      provider: expect.any(Object),
      user: expect.objectContaining({ name: expect.any(String), color: expect.any(String) }),
    }))
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
    expect(websocketMock.setLocalState).toHaveBeenCalledWith(null)
    expect(websocketMock.destroy).toHaveBeenCalled()
  })

  it('keeps persistence separate from sync and exposes a retry for protocol errors', async () => {
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Área de edición')).toBeInTheDocument())
    expect(screen.getByRole('status', { name: 'Persistencia del contenido' })).toHaveTextContent('Sin cambios')

    act(() => websocketMock.statusHandler({ status: 'connected' }))
    act(() => websocketMock.syncedHandler(true))
    const document = websocketMock.args[2] as Y.Doc
    vi.useFakeTimers()
    act(() => document.getText('content').insert(0, 'Cambio'))
    expect(screen.getByRole('status', { name: 'Persistencia del contenido' })).toHaveTextContent('Cambios pendientes')

    act(() => vi.advanceTimersByTime(500))
    expect(websocketMock.send).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status', { name: 'Persistencia del contenido' })).toHaveTextContent('Guardando contenido')

    const invalidResponse = decoding.createDecoder(Uint8Array.of(99))
    act(() => {
      const handler = websocketMock.messageHandlers[4] as (...args: unknown[]) => void
      handler({}, invalidResponse, {}, true, 4)
    })
    expect(screen.getByRole('status', { name: 'Persistencia del contenido' })).toHaveTextContent('No se pudo guardar')
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(websocketMock.send).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('does not offer retry for non-retryable persistence errors', async () => {
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Área de edición')).toBeInTheDocument())
    act(() => websocketMock.statusHandler({ status: 'connected' }))
    act(() => websocketMock.syncedHandler(true))
    const document = websocketMock.args[2] as Y.Doc
    vi.useFakeTimers()
    act(() => document.getText('content').insert(0, 'Cambio'))
    act(() => vi.advanceTimersByTime(500))

    const sentMessage = websocketMock.send.mock.calls[0][0] as Uint8Array
    const request = decoding.createDecoder(sentMessage)
    decoding.readVarUint(request)
    decoding.readVarUint(request)
    decoding.readVarUint(request)
    const requestId = decoding.readVarUint8Array(request)
    const response = new Uint8Array([1, 2, 16, ...requestId, 19, ...new TextEncoder().encode('STATE_NOT_AVAILABLE'), 0])
    act(() => {
      const handler = websocketMock.messageHandlers[4] as (...args: unknown[]) => void
      handler({}, decoding.createDecoder(response), {}, true, 4)
    })

    expect(screen.getByRole('status', { name: 'Persistencia del contenido' })).toHaveTextContent('No se pudo guardar')
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('reports an initial disconnection as offline before ever connecting', async () => {
    render(<Editor documentId="doc-42" onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: /título del documento/i })).toBeEnabled())

    act(() => websocketMock.statusHandler({ status: 'disconnected' }))

    expect(screen.getByText('Sin conexión')).toBeInTheDocument()
  })

})
