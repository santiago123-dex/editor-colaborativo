import { useEffect, useState } from 'react'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { DurabilityController, type PersistenceState } from './DurabilityController'
import { MESSAGE_DURABILITY, readDurabilityResponse } from './durabilityProtocol'
import { createPresenceIdentity, type PresenceIdentity } from './presenceIdentity'

export type ConnectionState = 'loading' | 'connecting' | 'synchronizing' | 'ready' | 'reconnecting' | 'offline'

export interface CollaborationSession {
  document: Y.Doc
  provider: WebsocketProvider
  identity: PresenceIdentity
  durability: DurabilityController
}

export interface CollaborationSessionResult {
  session: CollaborationSession | null
  connectionState: ConnectionState
  persistenceState: PersistenceState
}

const WEBSOCKET_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:3000/ws'

export function useCollaborationSession(
  documentId: string,
  loadedDocumentId: string | null,
): CollaborationSessionResult {
  const [session, setSession] = useState<CollaborationSession | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>('loading')
  const [persistenceState, setPersistenceState] = useState<PersistenceState>({ status: 'unchanged' })

  useEffect(() => {
    if (loadedDocumentId !== documentId) {
      setSession(null)
      return
    }

    const document = new Y.Doc()
    const identity = createPresenceIdentity()
    const provider = new WebsocketProvider(WEBSOCKET_URL, documentId, document, { connect: false })
    const durability = new DurabilityController(document, (message) => {
      const socket = provider.ws
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open')
      socket.send(message)
    }, { ignoredOrigin: provider, onStateChange: setPersistenceState })
    provider.messageHandlers[MESSAGE_DURABILITY] = (_encoder, decoder) => {
      try {
        durability.handleResponse(readDurabilityResponse(decoder))
      } catch {
        durability.handleInvalidResponse()
      }
    }
    let hasConnected = false
    let isConnected = false

    setConnectionState('connecting')
    const handleStatus = ({ status }: { status: string }) => {
      if (status === 'connected') {
        hasConnected = true
        isConnected = true
        setConnectionState('synchronizing')
        durability.setConnection(true)
      } else if (status === 'connecting') {
        isConnected = false
        setConnectionState(hasConnected ? 'reconnecting' : 'connecting')
      } else if (status === 'disconnected') {
        isConnected = false
        durability.setConnection(false)
        setConnectionState(hasConnected ? 'reconnecting' : 'offline')
      }
    }
    const handleConnectionError = () => {
      isConnected = false
      durability.setConnection(false)
      setConnectionState('offline')
    }
    const handleSynced = (synced: boolean) => {
      durability.setSynced(synced)
      if (synced) setConnectionState('ready')
      else if (isConnected) setConnectionState('synchronizing')
    }

    provider.on('status', handleStatus)
    provider.on('connection-error', handleConnectionError)
    provider.on('synced', handleSynced)
    setSession({ document, provider, identity, durability })
    provider.connect()

    return () => {
      provider.off('status', handleStatus)
      provider.off('connection-error', handleConnectionError)
      provider.off('synced', handleSynced)
      durability.destroy()
      provider.awareness.setLocalState(null)
      provider.destroy()
      document.destroy()
    }
  }, [documentId, loadedDocumentId])

  return { session, connectionState, persistenceState }
}
