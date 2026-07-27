import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Participants } from './Participants'

class AwarenessMock {
  states = new Map<number, unknown>()
  handlers = new Set<() => void>()
  getStates() { return this.states }
  on(_event: 'change', handler: () => void) { this.handlers.add(handler) }
  off(_event: 'change', handler: () => void) { this.handlers.delete(handler) }
  update(clientId: number, state: unknown) {
    this.states.set(clientId, state)
    this.handlers.forEach((handler) => handler())
  }
}

describe('Participants', () => {
  it('renders real awareness users accessibly and updates when awareness changes', async () => {
    const user = userEvent.setup()
    const awareness = new AwarenessMock()
    awareness.update(1, { user: { name: 'Ada', color: '#336699' } })
    const { unmount } = render(<Participants awareness={awareness} />)

    expect(screen.getByRole('button', { name: '1 participante conectado' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '1 participante conectado' }))
    expect(screen.getByRole('list')).toHaveTextContent('Ada')

    act(() => awareness.update(2, { user: { name: 'Grace', color: '#884422' } }))
    expect(screen.getByRole('button', { name: '2 participantes conectados' })).toBeInTheDocument()

    const off = vi.spyOn(awareness, 'off')
    unmount()
    expect(off).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('sanitizes remote names and never exposes arbitrary CSS colors', async () => {
    const user = userEvent.setup()
    const awareness = new AwarenessMock()
    awareness.update(1, { user: { name: `  ${'A'.repeat(50)}  `, color: '#A1b2C3' } })
    awareness.update(2, { user: { name: 'Mallory', color: 'red; background: url(https://evil.test)' } })
    awareness.update(3, { user: { name: '   ', color: '#336699' } })
    awareness.update(4, { user: { name: 42, color: '#336699' } })

    render(<Participants awareness={awareness} />)
    await user.click(screen.getByRole('button', { name: '2 participantes conectados' }))

    const list = screen.getByRole('list')
    expect(list).toHaveTextContent('A'.repeat(40))
    expect(list).not.toHaveTextContent('A'.repeat(41))
    expect(list).toHaveTextContent('Mallory')
    expect(list.innerHTML).not.toContain('url(')
    expect(list.innerHTML).not.toContain('evil.test')
  })

  it('discloses participants accessibly and closes on Escape or outside click with focus restored', async () => {
    const user = userEvent.setup()
    const awareness = new AwarenessMock()
    awareness.update(1, { user: { name: 'Ada', color: '#336699' } })
    render(<Participants awareness={awareness} />)
    const trigger = screen.getByRole('button', { name: '1 participante conectado' })

    await user.click(trigger)
    const list = screen.getByRole('list', { name: 'Participantes conectados' })
    expect(trigger).toHaveAttribute('aria-controls', list.id)
    act(() => fireEvent.keyDown(list, { key: 'Escape' }))
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    await user.click(trigger)
    act(() => fireEvent.mouseDown(document.body))
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
