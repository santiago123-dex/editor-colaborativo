import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  getChatMessages,
  type ChatMessage,
  type CreateChatMessage,
} from '../api/chat'
import {
  getChatWebSocketUrl,
  loadOrCreateChatAuthor,
  saveChatAuthor,
} from '../chat/chatIdentity'

type ChatConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline'
type PendingState = 'sending' | 'error'

interface PendingMessage {
  payload: CreateChatMessage
  state: PendingState
}

interface ServerError {
  type: 'error'
  code: string
  message: string
  clientMessageId?: string
}

interface ChatPanelProps {
  documentId: string
  isOpen?: boolean
  onClose?: () => void
  onUnreadMessage?: () => void
}

const CONNECTION_LABELS: Record<ChatConnectionState, string> = {
  connecting: 'Conectando chat',
  connected: 'Chat conectado',
  reconnecting: 'Reconectando chat',
  offline: 'Chat sin conexión',
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const merged = [...current]
  for (const message of incoming) {
    if (!merged.some((existing) => (
      existing.id === message.id || existing.clientMessageId === message.clientMessageId
    ))) merged.push(message)
  }
  return merged.sort((left, right) => {
    const leftTime = Date.parse(left.createdAt)
    const rightTime = Date.parse(right.createdAt)
    if (Number.isNaN(leftTime)) return Number.isNaN(rightTime) ? left.id.localeCompare(right.id) : 1
    if (Number.isNaN(rightTime)) return -1
    return leftTime - rightTime || left.id.localeCompare(right.id)
  })
}

function getMessageDate(createdAt: string) {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return null
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
    .join('-')
  return { date, day }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isCreatedMessage(value: unknown): value is { type: 'message:created'; message: ChatMessage } {
  if (!isRecord(value) || value.type !== 'message:created' || !isRecord(value.message)) return false
  const message = value.message
  return isNonBlankString(message.id) &&
    isNonBlankString(message.clientMessageId) &&
    isNonBlankString(message.documentId) &&
    isNonBlankString(message.author) &&
    isNonBlankString(message.content) &&
    isNonBlankString(message.createdAt) &&
    !Number.isNaN(Date.parse(message.createdAt))
}

function isServerError(value: unknown): value is ServerError {
  return isRecord(value) && value.type === 'error' &&
    isNonBlankString(value.code) &&
    isNonBlankString(value.message) &&
    (value.clientMessageId === undefined || isNonBlankString(value.clientMessageId))
}

export function ChatPanel({
  documentId,
  isOpen = true,
  onClose,
  onUnreadMessage,
}: ChatPanelProps) {
  const [author, setAuthor] = useState(loadOrCreateChatAuthor)
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [connectionState, setConnectionState] = useState<ChatConnectionState>('connecting')
  const [pending, setPending] = useState<PendingMessage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const pendingRef = useRef<PendingMessage | null>(null)
  const messageListRef = useRef<HTMLOListElement>(null)
  const messageInputRef = useRef<HTMLTextAreaElement>(null)
  const shouldAutoScrollRef = useRef(true)
  const isOpenRef = useRef(isOpen)
  const onUnreadMessageRef = useRef(onUnreadMessage)

  isOpenRef.current = isOpen
  onUnreadMessageRef.current = onUnreadMessage

  function updatePending(next: PendingMessage | null) {
    pendingRef.current = next
    setPending(next)
  }

  function sendPending() {
    const current = pendingRef.current
    if (!current || socketRef.current?.readyState !== WebSocket.OPEN) return
    socketRef.current.send(JSON.stringify(current.payload))
    updatePending({ ...current, state: 'sending' })
    setError(null)
  }

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    let socket: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempt = 0
    let hasConnected = false

    setMessages([])
    setHistoryLoading(true)
    setError(null)
    updatePending(null)
    shouldAutoScrollRef.current = true

    getChatMessages(documentId, controller.signal)
      .then((history) => {
        if (active) {
          shouldAutoScrollRef.current = true
          setMessages((current) => mergeMessages(current, history))
          setHistoryLoading(false)
        }
      })
      .catch((loadError: unknown) => {
        if (active && !controller.signal.aborted) {
          setHistoryLoading(false)
          setError(loadError instanceof Error ? loadError.message : 'No se pudo cargar el historial del chat')
        }
      })

    const scheduleReconnect = () => {
      if (!active || reconnectTimer !== null) return
      if (!navigator.onLine) {
        setConnectionState('offline')
        return
      }
      setConnectionState(hasConnected ? 'reconnecting' : 'offline')
      const delay = Math.min(500 * (2 ** reconnectAttempt), 10_000)
      reconnectAttempt += 1
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delay)
    }

    const connect = () => {
      if (!active || !navigator.onLine) {
        setConnectionState('offline')
        return
      }
      setConnectionState(hasConnected ? 'reconnecting' : 'connecting')
      const currentSocket = new WebSocket(getChatWebSocketUrl(documentId))
      socket = currentSocket
      socketRef.current = currentSocket
      currentSocket.onopen = () => {
        if (!active || socketRef.current !== currentSocket) return
        hasConnected = true
        reconnectAttempt = 0
        setConnectionState('connected')
        sendPending()
      }
      currentSocket.onmessage = (event) => {
        if (!active || socketRef.current !== currentSocket) return
        let payload: unknown
        try {
          payload = JSON.parse(String(event.data))
        } catch {
          setError('El chat recibió una respuesta inválida')
          return
        }
        if (isCreatedMessage(payload)) {
          if (payload.message.documentId !== documentId) {
            setError('El chat recibió una respuesta inválida')
            return
          }
          const isOwnPending = pendingRef.current?.payload.clientMessageId === payload.message.clientMessageId
          setMessages((current) => mergeMessages(current, [payload.message]))
          if (isOwnPending) {
            updatePending(null)
          } else if (!isOpenRef.current) {
            onUnreadMessageRef.current?.()
          }
          return
        }
        if (isServerError(payload)) {
          setError(payload.message)
          if (
            payload.clientMessageId &&
            pendingRef.current?.payload.clientMessageId === payload.clientMessageId
          ) updatePending({ ...pendingRef.current, state: 'error' })
          return
        }
        setError('El chat recibió una respuesta inválida')
      }
      currentSocket.onerror = () => {
        if (active && socketRef.current === currentSocket) setConnectionState('offline')
      }
      currentSocket.onclose = () => {
        currentSocket.onopen = null
        currentSocket.onmessage = null
        currentSocket.onerror = null
        currentSocket.onclose = null
        if (!active || socketRef.current !== currentSocket) return
        socketRef.current = null
        scheduleReconnect()
      }
    }

    const handleOffline = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      setConnectionState('offline')
      socket?.close()
    }
    const handleOnline = () => {
      if (active && socketRef.current === null && reconnectTimer === null) connect()
    }

    connect()
    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)

    return () => {
      active = false
      controller.abort()
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
      if (socket) {
        socket.onopen = null
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
        socket.close()
      }
      socketRef.current = null
    }
  }, [documentId])

  useEffect(() => {
    const list = messageListRef.current
    if (list && shouldAutoScrollRef.current) list.scrollTop = list.scrollHeight
  }, [messages])

  const wasOpenRef = useRef(isOpen)
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      shouldAutoScrollRef.current = true
      const list = messageListRef.current
      if (list) list.scrollTop = list.scrollHeight
      messageInputRef.current?.focus()
    }
    wasOpenRef.current = isOpen
  }, [isOpen])

  function submit(event?: FormEvent) {
    event?.preventDefault()
    const trimmedAuthor = author.trim()
    const content = draft.trim()
    if (
      pendingRef.current ||
      socketRef.current?.readyState !== WebSocket.OPEN ||
      trimmedAuthor.length < 1 || trimmedAuthor.length > 40 ||
      content.length < 1 || content.length > 1000
    ) return

    const next: PendingMessage = {
      payload: {
        type: 'message:create',
        clientMessageId: crypto.randomUUID(),
        author: trimmedAuthor,
        content,
      },
      state: 'sending',
    }
    setAuthor(trimmedAuthor)
    saveChatAuthor(trimmedAuthor)
    setDraft('')
    updatePending(next)
    socketRef.current.send(JSON.stringify(next.payload))
  }

  function handleMessageKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  const canSend = connectionState === 'connected' && !pending &&
    author.trim().length >= 1 && author.trim().length <= 40 &&
    draft.trim().length >= 1 && draft.trim().length <= 1000

  return (
    <aside
      className="chat-panel"
      aria-label="Chat del documento"
      hidden={!isOpen}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && onClose) onClose()
      }}
    >
      <header className="chat-panel__header">
        <div>
          <p className="eyebrow">CONVERSACIÓN</p>
          <h2>Chat</h2>
        </div>
        <span className={`chat-status chat-status--${connectionState}`} role="status">
          {CONNECTION_LABELS[connectionState]}
        </span>
        {onClose && (
          <button className="chat-panel__close" type="button" onClick={onClose} aria-label="Cerrar chat">
            ×
          </button>
        )}
      </header>

      <ol
        className="chat-messages"
        aria-label="Historial de mensajes"
        ref={messageListRef}
        onScroll={(event) => {
          const list = event.currentTarget
          shouldAutoScrollRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48
        }}
      >
        {historyLoading && (
          <li className="chat-messages__state" role="status" aria-label="Cargando historial">
            Cargando historial…
          </li>
        )}
        {!historyLoading && messages.length === 0 && (
          <li className="chat-messages__state">
            <strong>Todavía no hay mensajes</strong>
            <span>Cuando alguien escriba, la conversación va a aparecer acá.</span>
          </li>
        )}
        {messages.map((message, index) => {
          const messageDate = getMessageDate(message.createdAt)
          const previousDate = index > 0 ? getMessageDate(messages[index - 1].createdAt) : null
          const startsDay = messageDate !== null && messageDate.day !== previousDate?.day
          return (
            <li key={message.id} className="chat-message">
              {startsDay && (
                <div className="chat-date-separator" role="separator">
                  <time dateTime={messageDate.day}>
                    {messageDate.date.toLocaleDateString([], {
                      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
                    })}
                  </time>
                </div>
              )}
              <div className="chat-message__meta">
                <strong>{message.author}</strong>
                {messageDate ? (
                  <time dateTime={message.createdAt}>
                    {messageDate.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </time>
                ) : <span>Hora desconocida</span>}
              </div>
              <p>{message.content}</p>
            </li>
          )
        })}
      </ol>

      {error && <p className="chat-error" role="alert">{error}</p>}
      {pending && (
        <div className="chat-pending">
          {pending.state === 'sending' ? (
            <span role="status">Enviando…</span>
          ) : (
            <>
              <button type="button" onClick={sendPending} disabled={connectionState !== 'connected'}>
                Reintentar mensaje
              </button>
              <button type="button" onClick={() => { updatePending(null); setError(null) }}>
                Descartar mensaje
              </button>
            </>
          )}
        </div>
      )}

      <form className="chat-compose" onSubmit={submit}>
        <label htmlFor="chat-author">Tu nombre</label>
        <input
          id="chat-author"
          value={author}
          maxLength={40}
          onChange={(event) => {
            setAuthor(event.target.value)
            saveChatAuthor(event.target.value)
          }}
        />
        <label htmlFor="chat-message">Mensaje</label>
        <textarea
          ref={messageInputRef}
          id="chat-message"
          value={draft}
          maxLength={1000}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleMessageKeyDown}
          aria-describedby="chat-message-help"
        />
        <div className="chat-compose__footer">
          <span id="chat-message-help">Enter envía · Shift+Enter agrega una línea</span>
          {draft.length >= 900 && (
            <span className="chat-counter" aria-label={`${draft.length} de 1000 caracteres`}>
              {draft.length}/1000
            </span>
          )}
          <button type="submit" disabled={!canSend}>Enviar mensaje</button>
        </div>
      </form>
    </aside>
  )
}
