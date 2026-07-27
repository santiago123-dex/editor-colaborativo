import { useEffect, useRef, useState, useCallback } from 'react'

export type WebSocketStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline'

export interface UseWebSocketOptions {
  url: string
  onMessage: (event: MessageEvent) => void
  reconnect?: boolean
  onStatusChange?: (status: WebSocketStatus) => void
}

export interface UseWebSocketResult {
  status: WebSocketStatus
  send: (data: string | ArrayBuffer | Blob) => void
  readyState: number
}

export function useWebSocket({
  url,
  onMessage,
  reconnect = true,
  onStatusChange,
}: UseWebSocketOptions): UseWebSocketResult {
  const [status, setStatus] = useState<WebSocketStatus>('connecting')
  const [readyState, setReadyState] = useState(WebSocket.CONNECTING)
  const socketRef = useRef<WebSocket | null>(null)
  const activeRef = useRef(true)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)
  const hasConnectedRef = useRef(false)

  function setConnectionStatus(next: WebSocketStatus) {
    setStatus(next)
    onStatusChange?.(next)
  }

  useEffect(() => {
    activeRef.current = true
    let socket: WebSocket | null = null
    let reconnectAttempt = 0
    let hasConnected = false

    const scheduleReconnect = () => {
      if (!activeRef.current || reconnectTimerRef.current !== null) return
      if (!navigator.onLine) {
        setConnectionStatus('offline')
        return
      }
      setConnectionStatus(hasConnected ? 'reconnecting' : 'offline')
      const delay = Math.min(500 * (2 ** reconnectAttempt), 10_000)
      reconnectAttempt += 1
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        connect()
      }, delay)
    }

    const connect = () => {
      if (!activeRef.current || !navigator.onLine) {
        setConnectionStatus('offline')
        return
      }
      setConnectionStatus(hasConnected ? 'reconnecting' : 'connecting')
      const currentSocket = new WebSocket(url)
      socket = currentSocket
      socketRef.current = currentSocket
      setReadyState(WebSocket.CONNECTING)

      currentSocket.onopen = () => {
        if (!activeRef.current || socketRef.current !== currentSocket) return
        hasConnected = true
        hasConnectedRef.current = true
        reconnectAttempt = 0
        reconnectAttemptRef.current = 0
        setReadyState(WebSocket.OPEN)
        setConnectionStatus('connected')
      }

      currentSocket.onmessage = (event) => {
        if (!activeRef.current || socketRef.current !== currentSocket) return
        onMessage(event)
      }

      currentSocket.onerror = () => {
        if (activeRef.current && socketRef.current === currentSocket) {
          setReadyState(WebSocket.CLOSED)
          setConnectionStatus('offline')
        }
      }

      currentSocket.onclose = () => {
        currentSocket.onopen = null
        currentSocket.onmessage = null
        currentSocket.onerror = null
        currentSocket.onclose = null
        if (!activeRef.current || socketRef.current !== currentSocket) return
        socketRef.current = null
        setReadyState(WebSocket.CLOSED)
        if (reconnect) scheduleReconnect()
      }
    }

    const handleOffline = () => {
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      setConnectionStatus('offline')
      socket?.close()
    }

    const handleOnline = () => {
      if (activeRef.current && socketRef.current === null && reconnectTimerRef.current === null) connect()
    }

    connect()
    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)

    return () => {
      activeRef.current = false
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
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
  }, [url, onMessage, reconnect])

  const send = useCallback((data: string | ArrayBuffer | Blob) => {
    socketRef.current?.send(data)
  }, [])

  return { status, send, readyState }
}
