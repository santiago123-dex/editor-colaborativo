import { act, fireEvent, render, screen } from '@testing-library/react'
import { ShareDocumentButton } from './ShareDocumentButton'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('ShareDocumentButton', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('copies the canonical current URL and clears its temporary confirmation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    window.history.replaceState({}, '', '/documents/doc-42?from=list#selection')
    render(<ShareDocumentButton />)

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copiar enlace del documento' })))
    expect(writeText).toHaveBeenCalledWith(new URL('/documents/doc-42', window.location.origin).href)
    expect(screen.getByRole('status')).toHaveTextContent('Enlace copiado')

    act(() => vi.advanceTimersByTime(2500))
    expect(screen.queryByText('Enlace copiado')).not.toBeInTheDocument()
  })

  it('shows an actionable error and retries after Clipboard API fails', async () => {
    const writeText = vi.fn()
      .mockRejectedValueOnce(new Error('blocked'))
      .mockResolvedValueOnce(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<ShareDocumentButton />)

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copiar enlace del documento' })))
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo copiar el enlace')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reintentar copia' })))
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status')).toHaveTextContent('Enlace copiado')
  })

  it('clears the feedback timer on unmount', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    const { unmount } = render(<ShareDocumentButton />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copiar enlace del documento' })))
    unmount()
    expect(clearTimeoutSpy).toHaveBeenCalled()
  })

  it('keeps the newest copy result when an older operation settles later', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    const writeText = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<ShareDocumentButton />)
    const share = screen.getByRole('button', { name: 'Copiar enlace del documento' })

    fireEvent.click(share)
    fireEvent.click(share)
    await act(async () => second.resolve())
    expect(screen.getByRole('status')).toHaveTextContent('Enlace copiado')

    await act(async () => first.reject(new Error('old failure')))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Enlace copiado')
  })

  it('does not create feedback state or timers when a copy settles after unmount', async () => {
    const copy = deferred<void>()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockReturnValue(copy.promise) },
    })
    const view = render(<ShareDocumentButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Copiar enlace del documento' }))
    view.unmount()

    await act(async () => copy.resolve())

    expect(vi.getTimerCount()).toBe(0)
  })
})
