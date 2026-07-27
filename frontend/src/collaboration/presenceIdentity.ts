import { loadOrCreateChatAuthor } from '../chat/chatIdentity'

export interface PresenceIdentity {
  name: string
  color: string
}

const COLORS = ['#526f35', '#315f72', '#7a4939', '#684f7d', '#8a641f', '#366b61']

export function createPresenceIdentity(email?: string | null): PresenceIdentity {
  const name = email?.trim() || loadOrCreateChatAuthor()
  let hash = 0
  for (const character of name) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0
  return { name, color: COLORS[Math.abs(hash) % COLORS.length] }
}
