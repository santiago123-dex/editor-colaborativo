import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuthSessionContextValue } from '../auth/AuthSessionContext'
import { AuthSessionContext } from '../auth/AuthSessionContext'
import { HttpError } from '../api/http'
import { AuthControls } from './AuthControls'

function renderControls(overrides: Partial<AuthSessionContextValue> = {}) {
  const value: AuthSessionContextValue = {
    status: 'ready',
    session: { user: null, csrfToken: 'csrf' },
    revision: 1,
    error: null,
    login: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn(),
    ...overrides,
  }
  return { value, ...render(<AuthSessionContext.Provider value={value}><AuthControls /></AuthSessionContext.Provider>) }
}

describe('AuthControls', () => {
  it('shows guest actions and submits login without retaining fields after close', async () => {
    const user = userEvent.setup()
    const { value } = renderControls()
    const trigger = screen.getByRole('button', { name: 'Entrar' })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: /entrar/i })
    const email = within(dialog).getByRole('textbox', { name: /email/i })
    const password = within(dialog).getByLabelText(/contraseña/i)
    expect(email).toHaveFocus()
    expect(password).toHaveAttribute('minlength', '12')
    expect(password).toHaveAttribute('maxlength', '128')

    await user.type(email, 'person@example.com')
    await user.type(password, 'password-1234')
    await user.click(within(dialog).getByRole('button', { name: 'Entrar' }))

    await waitFor(() => expect(value.login).toHaveBeenCalledWith('person@example.com', 'password-1234'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    await user.click(trigger)
    expect(screen.getByRole('textbox', { name: /email/i })).toHaveValue('')
    expect(screen.getByLabelText(/contraseña/i)).toHaveValue('')
  })

  it('registers, reports errors, and closes with Escape', async () => {
    const user = userEvent.setup()
    const register = vi.fn().mockRejectedValue(new Error('El email ya está registrado'))
    const { value } = renderControls({ register })
    const trigger = screen.getByRole('button', { name: /crear cuenta/i })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: /crear cuenta/i })
    await user.type(within(dialog).getByRole('textbox', { name: /email/i }), 'person@example.com')
    await user.type(within(dialog).getByLabelText(/contraseña/i), 'password-1234')
    await user.click(within(dialog).getByRole('button', { name: /crear cuenta/i }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('El email ya está registrado')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(value.register).toHaveBeenCalled()
  })

  it('shows SESSION_CHANGED without retrying the unsafe operation', async () => {
    const user = userEvent.setup()
    const login = vi.fn().mockRejectedValue(
      new HttpError(409, 'La sesión cambió en otra pestaña', 'SESSION_CHANGED'),
    )
    renderControls({ login })
    await user.click(screen.getByRole('button', { name: 'Entrar' }))
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByRole('textbox', { name: /email/i }), 'person@example.com')
    await user.type(within(dialog).getByLabelText(/contraseña/i), 'password-1234')
    await user.click(within(dialog).getByRole('button', { name: 'Entrar' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('La sesión cambió en otra pestaña')
    expect(login).toHaveBeenCalledTimes(1)
  })

  it('shows the authenticated email and logs out', async () => {
    const user = userEvent.setup()
    const logout = vi.fn().mockResolvedValue(undefined)
    renderControls({
      session: { user: { id: 'user-1', email: 'person@example.com' }, csrfToken: 'csrf' },
      logout,
    })

    expect(screen.getByText('person@example.com')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Salir' }))
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))
  })

  it('keeps authenticated controls available when logout fails', async () => {
    const user = userEvent.setup()
    const logout = vi.fn().mockRejectedValue(new Error('No se pudo cerrar la sesión'))
    renderControls({
      session: { user: { id: 'user-1', email: 'person@example.com' }, csrfToken: 'csrf' },
      logout,
    })

    await user.click(screen.getByRole('button', { name: 'Salir' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cerrar la sesión')
    expect(screen.getByText('person@example.com')).toBeInTheDocument()
  })

  it('traps focus inside the authentication dialog', async () => {
    const user = userEvent.setup()
    renderControls()
    await user.click(screen.getByRole('button', { name: 'Entrar' }))
    const dialog = screen.getByRole('dialog')
    const email = within(dialog).getByRole('textbox', { name: /email/i })
    const submit = within(dialog).getByRole('button', { name: 'Entrar' })

    submit.focus()
    await user.tab()
    expect(email).toHaveFocus()
    email.focus()
    await user.tab({ shift: true })
    expect(submit).toHaveFocus()
  })
})
