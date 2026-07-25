import {
  createDocument,
  deleteDocument,
  type DocumentDetails,
  getDocument,
  getDocuments,
  updateDocumentTitle,
} from './documents'
import { setCsrfToken } from './http'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false

const documentDetailsContentIsString: Equal<DocumentDetails['content'], string> = true

void documentDetailsContentIsString

describe('documents API', () => {
  beforeEach(() => setCsrfToken('test-csrf'))
  afterEach(() => setCsrfToken(null))

  it('lists documents using the configured REST endpoint', async () => {
    const documents = [
      {
        id: 'doc-1',
        title: 'Notas',
        createdAt: '2026-07-22T10:00:00.000Z',
        updatedAt: '2026-07-22T11:00:00.000Z',
      },
    ]
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(documents), { status: 200 }),
    )

    await expect(getDocuments()).resolves.toEqual(documents)
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/documents$/), {
      credentials: 'include',
    })
  })

  it('loads document details and encodes its ID', async () => {
    const document = {
      id: 'doc/with spaces',
      title: 'Notas',
      content: '',
      createdAt: '2026-07-22T10:00:00.000Z',
      updatedAt: '2026-07-22T11:00:00.000Z',
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(document), { status: 200 }),
    )

    await expect(getDocument('doc/with spaces')).resolves.toEqual(document)
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/documents\/doc%2Fwith%20spaces$/), {
      credentials: 'include',
    })
  })

  it('updates a title with JSON headers and returns the normalized response', async () => {
    const updated = {
      id: 'doc/1',
      title: 'Título normalizado',
      createdAt: '2026-07-22T10:00:00.000Z',
      updatedAt: '2026-07-22T12:00:00.000Z',
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(updated), { status: 200 }),
    )

    await expect(updateDocumentTitle('doc/1', '  Título normalizado  ')).resolves.toEqual(updated)
    const updateInit = vi.mocked(fetch).mock.calls[0][1]
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/documents\/doc%2F1$/), expect.objectContaining({
      method: 'PATCH',
      credentials: 'include',
      body: JSON.stringify({ title: '  Título normalizado  ' }),
    }))
    expect(new Headers(updateInit?.headers).get('Content-Type')).toBe('application/json')
    expect(new Headers(updateInit?.headers).get('X-CSRF-Token')).toBe('test-csrf')
  })

  it('deletes a document without parsing the 204 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    await expect(deleteDocument('doc/1')).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/documents\/doc%2F1$/), expect.objectContaining({
      method: 'DELETE',
      credentials: 'include',
    }))
  })

  it('creates an empty document with POST', async () => {
    const created = { id: 'doc-2', createdAt: '2026-07-22T11:00:00.000Z' }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(created), { status: 201 }),
    )

    await expect(createDocument()).resolves.toEqual(created)
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/documents$/), expect.objectContaining({
      method: 'POST',
      credentials: 'include',
    }))
  })

  it('uses the operation fallback when an error has no useful payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }))

    await expect(getDocuments()).rejects.toMatchObject({
      status: 500,
      message: 'No se pudieron cargar los documentos',
    })
  })

  it('explains when the backend cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(getDocuments()).rejects.toThrow(/No se pudo conectar con el backend en https?:\/\//)
  })

  it('preserves AbortError objects even when they are not DOMException instances', async () => {
    const abortError = { name: 'AbortError', message: 'aborted' }
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError)

    await expect(getDocuments()).rejects.toBe(abortError)
  })

  it('preserves a fetch rejection when its request signal was aborted', async () => {
    const controller = new AbortController()
    const fetchError = new TypeError('fetch cancelled')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort()
      throw fetchError
    })

    await expect(getDocuments(controller.signal)).rejects.toBe(fetchError)
  })
})
