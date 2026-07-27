import { getChatMessages } from './chat'

describe('chat API', () => {
  it('loads the last 50 messages for an encoded document ID and forwards AbortSignal', async () => {
    const messages = [{
      id: 'message-1',
      documentId: 'doc/one',
      clientMessageId: 'client-1',
      author: 'Ada',
      content: 'Hola',
      createdAt: '2026-07-22T10:00:00.000Z',
    }]
    const controller = new AbortController()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(messages), { status: 200 }),
    )

    await expect(getChatMessages('doc/one', controller.signal)).resolves.toEqual(messages)
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/documents\/doc%2Fone\/messages\?limit=50$/),
      { signal: controller.signal, credentials: 'include' },
    )
  })

  it('uses a useful operation error when history cannot be loaded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }))

    await expect(getChatMessages('doc-1')).rejects.toMatchObject({
      status: 500,
      message: 'No se pudo cargar el historial del chat',
    })
  })
})
