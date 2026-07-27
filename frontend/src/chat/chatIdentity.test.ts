import { getChatWebSocketUrl, loadOrCreateChatAuthor, saveChatAuthor } from './chatIdentity'

describe('chat identity and URL', () => {
  it('uses the complete chat base and encodes the document ID', () => {
    expect(getChatWebSocketUrl('doc/with spaces', 'ws://chat.test/ws/chat', 'ws://ignored/ws'))
      .toBe('ws://chat.test/ws/chat/doc%2Fwith%20spaces')
  })

  it('derives the chat base by appending chat to the collaboration URL', () => {
    expect(getChatWebSocketUrl('doc-1', null, 'wss://app.test/ws'))
      .toBe('wss://app.test/ws/chat/doc-1')
  })

  it('loads a valid saved author', () => {
    localStorage.setItem('editor-colaborativo.chat-author', '  Ada  ')
    expect(loadOrCreateChatAuthor()).toBe('Ada')
  })

  it('creates and persists a guest author when none is valid', () => {
    localStorage.clear()
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789abc')

    expect(loadOrCreateChatAuthor()).toBe('Invitado-12345678')
    expect(localStorage.getItem('editor-colaborativo.chat-author')).toBe('Invitado-12345678')
  })

  it('keeps working when storage access is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('abcdef12-1234-4234-8234-123456789abc')

    expect(loadOrCreateChatAuthor()).toBe('Invitado-abcdef12')
    expect(() => saveChatAuthor('Grace')).not.toThrow()
  })
})
