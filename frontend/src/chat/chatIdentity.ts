const AUTHOR_STORAGE_KEY = 'editor-colaborativo.chat-author'

export function getChatWebSocketUrl(
  documentId: string,
  chatUrl: string | null | undefined = import.meta.env.VITE_CHAT_WS_URL,
  collaborationUrl = import.meta.env.VITE_WS_URL ?? 'ws://localhost:3000/ws',
): string {
  const base = (chatUrl ?? `${collaborationUrl.replace(/\/$/, '')}/chat`).replace(/\/$/, '')
  return `${base}/${encodeURIComponent(documentId)}`
}

export function saveChatAuthor(author: string): void {
  try {
    localStorage.setItem(AUTHOR_STORAGE_KEY, author)
  } catch {
    // Private browsing and storage policies must not prevent chat usage.
  }
}

export function loadOrCreateChatAuthor(): string {
  try {
    const saved = localStorage.getItem(AUTHOR_STORAGE_KEY)?.trim()
    if (saved && saved.length <= 40) return saved
  } catch {
    // Generate an in-memory identity when storage is unavailable.
  }

  const author = `Invitado-${crypto.randomUUID().slice(0, 8)}`
  saveChatAuthor(author)
  return author
}
