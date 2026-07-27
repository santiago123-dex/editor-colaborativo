import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getChatMessages, type ChatMessage } from '../api/chat'
import { ChatPanel } from './ChatPanel'

const chatApiMock = vi.hoisted(() => ({ getChatMessages: vi.fn() }))

vi.mock('../api/chat', async () => {
  const actual = await vi.importActual<typeof import('../api/chat')>('../api/chat')
  return { ...actual, getChatMessages: chatApiMock.getChatMessages }
})

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly url: string
  readyState = MockWebSocket.CONNECTING
  sent: string[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    MockWebSocket.instances.push(this)
  }

  open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  receive(payload: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }))
  }

  receiveRaw(data: string) {
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  disconnect() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
  }
}

const historyMessage: ChatMessage = {
  id: 'message-history',
  documentId: 'doc-42',
  clientMessageId: 'client-shared',
  author: 'Ada',
  content: 'Desde historial',
  createdAt: '2026-07-22T10:00:00.000Z',
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

function renderChat(props: Partial<React.ComponentProps<typeof ChatPanel>> = {}) {
  return render(<ChatPanel documentId="doc-42" {...props} />)
}

describe('ChatPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('author123-1234-4234-8234-123456789abc')
      .mockReturnValue('client123-1234-4234-8234-123456789abc')
    chatApiMock.getChatMessages.mockReturnValue(new Promise(() => {}))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('renders an accessible chat and starts history and WebSocket in parallel', () => {
    chatApiMock.getChatMessages.mockReturnValue(new Promise(() => {}))
    renderChat()

    expect(screen.getByRole('complementary', { name: 'Chat del documento' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Tu nombre' })).toHaveValue('Invitado-author12')
    expect(screen.getByRole('textbox', { name: 'Tu nombre' })).toHaveAttribute('maxlength', '40')
    expect(screen.getByRole('textbox', { name: 'Mensaje' })).toHaveAttribute('maxlength', '1000')
    expect(screen.getByRole('button', { name: 'Enviar mensaje' })).toBeDisabled()
    expect(screen.getByText('Conectando chat')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Cargando historial' })).toBeInTheDocument()
    expect(chatApiMock.getChatMessages).toHaveBeenCalledWith('doc-42', expect.any(AbortSignal))
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0].url).toMatch(/\/ws\/chat\/doc-42$/)
  })

  it('shows a clear empty state after history finishes loading', async () => {
    chatApiMock.getChatMessages.mockResolvedValue([])
    renderChat()

    expect(await screen.findByText('Todavía no hay mensajes')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Cargando historial' })).not.toBeInTheDocument()
  })

  it('merges a WS message racing with history and deduplicates by id or clientMessageId', async () => {
    const history = deferred<ChatMessage[]>()
    chatApiMock.getChatMessages.mockReturnValue(history.promise)
    renderChat()
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.open()
      socket.receive({ type: 'message:created', message: { ...historyMessage, content: 'Desde WS' } })
    })
    await act(async () => history.resolve([
      historyMessage,
      { ...historyMessage, id: 'another-id', content: 'Duplicado por client id' },
    ]))

    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('Desde WS')).toBeInTheDocument()
  })

  it('orders merged messages by createdAt and id', async () => {
    chatApiMock.getChatMessages.mockResolvedValue([
      { ...historyMessage, id: 'b', clientMessageId: 'b', content: 'Segundo' },
      { ...historyMessage, id: 'a', clientMessageId: 'a', content: 'Primero' },
    ])
    renderChat()

    const items = await screen.findAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Primero'),
      expect.stringContaining('Segundo'),
    ])
  })

  it('renders accessible date separators whenever the chronological day changes', async () => {
    chatApiMock.getChatMessages.mockResolvedValue([
      { ...historyMessage, id: 'third', clientMessageId: 'third', content: 'Día dos', createdAt: '2026-07-23T09:00:00.000Z' },
      { ...historyMessage, id: 'first', clientMessageId: 'first', content: 'Día uno temprano', createdAt: '2026-07-22T08:00:00.000Z' },
      { ...historyMessage, id: 'second', clientMessageId: 'second', content: 'Día uno tarde', createdAt: '2026-07-22T20:00:00.000Z' },
    ])
    renderChat()

    const separators = await screen.findAllByRole('separator')
    expect(separators).toHaveLength(2)
    expect(separators[0].querySelector('time')).toHaveAttribute('datetime', '2026-07-22')
    expect(separators[1].querySelector('time')).toHaveAttribute('datetime', '2026-07-23')
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('Día uno temprano'),
      expect.stringContaining('Día uno tarde'),
      expect.stringContaining('Día dos'),
    ])
  })

  it('keeps invalid history dates usable without rendering Invalid Date', async () => {
    chatApiMock.getChatMessages.mockResolvedValue([
      { ...historyMessage, id: 'invalid', clientMessageId: 'invalid', content: 'Fecha rota', createdAt: 'not-a-date' },
    ])
    renderChat()

    expect(await screen.findByText('Fecha rota')).toBeInTheDocument()
    expect(screen.getByText('Hora desconocida')).toBeInTheDocument()
    expect(screen.queryByText(/invalid date/i)).not.toBeInTheDocument()
  })

  it('does not steal scroll when a new message arrives while reading older messages', async () => {
    chatApiMock.getChatMessages.mockResolvedValue([historyMessage])
    renderChat()
    const list = await screen.findByRole('list', { name: 'Historial de mensajes' })
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    })
    fireEvent.scroll(list)

    act(() => MockWebSocket.instances[0].receive({
      type: 'message:created',
      message: { ...historyMessage, id: 'new', clientMessageId: 'new', content: 'Nuevo' },
    }))

    expect(await screen.findByText('Nuevo')).toBeInTheDocument()
    expect(list.scrollTop).toBe(0)
  })

  it('reports new messages while the panel is closed', () => {
    const onUnreadMessage = vi.fn()
    renderChat({ isOpen: false, onUnreadMessage })

    act(() => MockWebSocket.instances[0].receive({
      type: 'message:created',
      message: { ...historyMessage, id: 'new', clientMessageId: 'new' },
    }))

    expect(onUnreadMessage).toHaveBeenCalledTimes(1)
  })

  it('trims and sends the exact protocol once, then confirms only on ACK', async () => {
    renderChat()
    const socket = MockWebSocket.instances[0]
    act(() => socket.open())
    fireEvent.change(screen.getByRole('textbox', { name: 'Tu nombre' }), { target: { value: '  Grace  ' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Mensaje' }), { target: { value: '  Hola equipo  ' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Mensaje' }), { key: 'Enter' })

    const payload = {
      type: 'message:create',
      clientMessageId: 'client123-1234-4234-8234-123456789abc',
      author: 'Grace',
      content: 'Hola equipo',
    }
    expect(socket.sent).toEqual([JSON.stringify(payload)])
    expect(screen.getByRole('textbox', { name: 'Mensaje' })).toHaveValue('')
    expect(screen.getByText('Enviando…')).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()

    act(() => socket.receive({ type: 'message:created', message: {
      ...historyMessage,
      id: 'confirmed',
      clientMessageId: payload.clientMessageId,
      author: payload.author,
      content: payload.content,
    } }))
    expect(await screen.findByText('Hola equipo')).toBeInTheDocument()
    expect(screen.queryByText('Enviando…')).not.toBeInTheDocument()
  })

  it.each([
    ['missing id', { ...historyMessage, id: undefined }],
    ['empty clientMessageId', { ...historyMessage, clientMessageId: '  ' }],
    ['missing documentId', { ...historyMessage, documentId: undefined }],
    ['empty author', { ...historyMessage, author: '' }],
    ['blank content', { ...historyMessage, content: '   ' }],
    ['invalid createdAt', { ...historyMessage, createdAt: 'not-a-date' }],
  ])('rejects a created-message envelope with %s', (_case, message) => {
    renderChat()

    act(() => MockWebSocket.instances[0].receive({ type: 'message:created', message }))

    expect(screen.getByRole('alert')).toHaveTextContent('El chat recibió una respuesta inválida')
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('rejects messages from another document before merging them', () => {
    renderChat()

    act(() => MockWebSocket.instances[0].receive({
      type: 'message:created',
      message: { ...historyMessage, documentId: 'another-document' },
    }))

    expect(screen.getByRole('alert')).toHaveTextContent('El chat recibió una respuesta inválida')
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it.each([
    ['a missing message', { type: 'message:created' }],
    ['a null message', { type: 'message:created', message: null }],
    ['an unknown type', { type: 'message:updated', message: historyMessage }],
    ['a blank error code', { type: 'error', code: ' ', message: 'Rechazado' }],
    ['a blank error message', { type: 'error', code: 'invalid', message: '' }],
    ['an invalid error correlation ID', { type: 'error', code: 'invalid', message: 'Rechazado', clientMessageId: 42 }],
  ])('reports a protocol error for an envelope with %s', (_case, payload) => {
    renderChat()

    act(() => MockWebSocket.instances[0].receive(payload))

    expect(screen.getByRole('alert')).toHaveTextContent('El chat recibió una respuesta inválida')
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it.each([
    ['corrupt JSON', (socket: MockWebSocket) => socket.receiveRaw('{')],
    ['an incomplete own ACK', (socket: MockWebSocket) => socket.receive({
      type: 'message:created',
      message: { ...historyMessage, id: undefined, clientMessageId: 'client123-1234-4234-8234-123456789abc' },
    })],
    ['an invalid error envelope', (socket: MockWebSocket) => socket.receive({
      type: 'error',
      code: 400,
      message: 'Rechazado',
      clientMessageId: 'client123-1234-4234-8234-123456789abc',
    })],
  ])('keeps pending after %s', (_case, receiveInvalidPayload) => {
    renderChat()
    const socket = MockWebSocket.instances[0]
    act(() => socket.open())
    fireEvent.change(screen.getByRole('textbox', { name: 'Mensaje' }), { target: { value: 'Persistente' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar mensaje' }))

    act(() => receiveInvalidPayload(socket))

    expect(screen.getByRole('alert')).toHaveTextContent('El chat recibió una respuesta inválida')
    expect(screen.getByText('Enviando…')).toBeInTheDocument()
  })

  it('does not send on Shift+Enter or while composing with an IME', () => {
    renderChat()
    const socket = MockWebSocket.instances[0]
    act(() => socket.open())
    const message = screen.getByRole('textbox', { name: 'Mensaje' })
    fireEvent.change(message, { target: { value: 'Hola' } })
    fireEvent.keyDown(message, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(message, { key: 'Enter', isComposing: true })
    expect(socket.sent).toEqual([])
  })

  it('shows keyboard guidance and a character counter only near the message limit', () => {
    renderChat()
    const message = screen.getByRole('textbox', { name: 'Mensaje' })

    expect(screen.getByText('Enter envía · Shift+Enter agrega una línea')).toBeInTheDocument()
    expect(screen.queryByText(/\/1000$/)).not.toBeInTheDocument()
    fireEvent.change(message, { target: { value: 'a'.repeat(900) } })
    expect(screen.getByText('900/1000')).toBeInTheDocument()
  })

  it('keeps a pending payload across disconnect and resends the same ID on reconnect', () => {
    vi.useFakeTimers()
    renderChat()
    const firstSocket = MockWebSocket.instances[0]
    act(() => firstSocket.open())
    fireEvent.change(screen.getByRole('textbox', { name: 'Mensaje' }), { target: { value: 'Persistente' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar mensaje' }))
    const originalPayload = firstSocket.sent[0]

    act(() => firstSocket.disconnect())
    expect(screen.getByText('Reconectando chat')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(499))
    expect(MockWebSocket.instances).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(MockWebSocket.instances).toHaveLength(2)
    act(() => MockWebSocket.instances[1].open())
    expect(MockWebSocket.instances[1].sent).toEqual([originalPayload])
    vi.useRealTimers()
  })

  it('ignores late events from a socket that was replaced during reconnect', () => {
    vi.useFakeTimers()
    renderChat()
    const firstSocket = MockWebSocket.instances[0]
    act(() => firstSocket.disconnect())
    act(() => vi.advanceTimersByTime(500))

    expect(MockWebSocket.instances).toHaveLength(2)
    act(() => firstSocket.open())
    expect(screen.queryByText('Chat conectado')).not.toBeInTheDocument()
    expect(screen.getByText('Conectando chat')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('backs off failed connections from 500ms up to a 10s cap', () => {
    vi.useFakeTimers()
    renderChat()

    for (const delay of [500, 1000, 2000, 4000, 8000, 10_000, 10_000]) {
      const socketCount = MockWebSocket.instances.length
      act(() => MockWebSocket.instances[socketCount - 1].disconnect())
      act(() => vi.advanceTimersByTime(delay - 1))
      expect(MockWebSocket.instances).toHaveLength(socketCount)
      act(() => vi.advanceTimersByTime(1))
      expect(MockWebSocket.instances).toHaveLength(socketCount + 1)
    }
  })

  it('does not create reconnect loops while offline and reconnects on the online event', () => {
    vi.useFakeTimers()
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    renderChat()

    expect(screen.getByText('Chat sin conexión')).toBeInTheDocument()
    act(() => vi.runAllTimers())
    expect(MockWebSocket.instances).toHaveLength(0)

    online.mockReturnValue(true)
    act(() => window.dispatchEvent(new Event('online')))
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('allows retry or discard after a correlated server error, preserving the ID', () => {
    renderChat()
    const socket = MockWebSocket.instances[0]
    act(() => socket.open())
    fireEvent.change(screen.getByRole('textbox', { name: 'Mensaje' }), { target: { value: 'Hola' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar mensaje' }))
    const originalPayload = socket.sent[0]

    act(() => socket.receive({
      type: 'error', code: 'invalid', message: 'Mensaje rechazado',
      clientMessageId: 'client123-1234-4234-8234-123456789abc',
    }))
    expect(screen.getByRole('alert')).toHaveTextContent('Mensaje rechazado')
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar mensaje' }))
    expect(socket.sent).toEqual([originalPayload, originalPayload])

    act(() => socket.receive({
      type: 'error', code: 'invalid', message: 'Todavía rechazado',
      clientMessageId: 'client123-1234-4234-8234-123456789abc',
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Descartar mensaje' }))
    expect(screen.queryByText('Todavía rechazado')).not.toBeInTheDocument()
  })

  it('reports history failure without closing chat or the editor integration', async () => {
    chatApiMock.getChatMessages.mockRejectedValue(new Error('Historial caído'))
    renderChat()
    expect(await screen.findByRole('alert')).toHaveTextContent('Historial caído')
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('cancels history, socket callbacks and reconnect timers on cleanup', () => {
    vi.useFakeTimers()
    const { unmount } = renderChat()
    const signal = chatApiMock.getChatMessages.mock.calls[0][1] as AbortSignal
    const socket = MockWebSocket.instances[0]
    act(() => socket.disconnect())
    unmount()

    expect(signal.aborted).toBe(true)
    expect(socket.readyState).toBe(MockWebSocket.CLOSED)
    act(() => vi.runAllTimers())
    expect(MockWebSocket.instances).toHaveLength(1)
    vi.useRealTimers()
  })
})
