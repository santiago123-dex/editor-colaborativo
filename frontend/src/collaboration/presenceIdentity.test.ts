import { createPresenceIdentity } from './presenceIdentity'

describe('presence identity', () => {
  it('reuses an authenticated email and assigns a deterministic palette color', () => {
    expect(createPresenceIdentity('ada@example.com')).toEqual(createPresenceIdentity('ada@example.com'))
    expect(createPresenceIdentity('ada@example.com').name).toBe('ada@example.com')
    expect(createPresenceIdentity('ada@example.com').color).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('falls back to the stable chat author without coupling presence to chat transport', () => {
    localStorage.setItem('editor-colaborativo.chat-author', 'Grace')
    expect(createPresenceIdentity()).toMatchObject({ name: 'Grace' })
  })
})
