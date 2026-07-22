import { act, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { Editor } from './Editor'

const websocketMock = vi.hoisted(() => ({
  args: [] as unknown[],
  destroy: vi.fn(),
  statusHandler: (_event: { status: string }) => {},
}))

const placeholderMock = vi.hoisted(() => ({ configure: vi.fn(() => ({})) }))

vi.mock('y-websocket', () => ({
  WebsocketProvider: class {
    constructor(...args: unknown[]) {
      websocketMock.args = args
    }

    on(event: string, handler: (event: { status: string }) => void) {
      if (event === 'status') websocketMock.statusHandler = handler
    }

    off() {}

    destroy() {
      websocketMock.destroy()
    }
  },
}))

vi.mock('@tiptap/react', () => ({
  useEditor: () => ({}),
  EditorContent: () => <div aria-label="Área de edición" />,
}))

vi.mock('@tiptap/starter-kit', () => ({
  default: { configure: () => ({}) },
}))

vi.mock('@tiptap/extension-collaboration', () => ({
  default: { configure: () => ({}) },
}))

vi.mock('@tiptap/extension-placeholder', () => ({
  default: { configure: placeholderMock.configure },
}))

describe('Editor', () => {
  it('connects to the document room and reflects WebSocket status', () => {
    const { unmount } = render(<Editor documentId="doc-42" onBack={vi.fn()} />)

    expect(websocketMock.args[0]).toBe('ws://localhost:3000/ws')
    expect(websocketMock.args[1]).toBe('doc-42')
    expect(placeholderMock.configure).toHaveBeenCalledWith({
      placeholder: 'Empezá a escribir…',
    })
    expect(screen.getByText('Desconectado')).toBeInTheDocument()

    act(() => websocketMock.statusHandler({ status: 'connected' }))
    expect(screen.getByText('Conectado')).toBeInTheDocument()

    unmount()
    expect(websocketMock.destroy).toHaveBeenCalled()
  })
})
