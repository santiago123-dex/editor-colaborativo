import { request } from './http'

export interface ChatMessage {
  id: string
  documentId: string
  clientMessageId: string
  author: string
  content: string
  createdAt: string
}

export interface CreateChatMessage {
  type: 'message:create'
  clientMessageId: string
  author: string
  content: string
}

export function getChatMessages(documentId: string, signal?: AbortSignal): Promise<ChatMessage[]> {
  return request(
    `/documents/${encodeURIComponent(documentId)}/messages?limit=50`,
    'No se pudo cargar el historial del chat',
    signal ? { signal } : undefined,
  )
}
