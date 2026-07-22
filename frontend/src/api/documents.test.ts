import { createDocument, getDocuments } from './documents'

describe('documents API', () => {
  it('lists documents using the configured REST endpoint', async () => {
    const documents = [
      { id: 'doc-1', title: 'Notas', createdAt: '2026-07-22T10:00:00.000Z' },
    ]
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(documents), { status: 200 }),
    )

    await expect(getDocuments()).resolves.toEqual(documents)
    expect(fetch).toHaveBeenCalledWith('http://localhost:3000/documents')
  })

  it('creates an empty document with POST', async () => {
    const created = { id: 'doc-2', createdAt: '2026-07-22T11:00:00.000Z' }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(created), { status: 201 }),
    )

    await expect(createDocument()).resolves.toEqual(created)
    expect(fetch).toHaveBeenCalledWith('http://localhost:3000/documents', {
      method: 'POST',
    })
  })

  it('reports REST errors instead of returning invalid data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500 }),
    )

    await expect(getDocuments()).rejects.toThrow('No se pudieron cargar los documentos')
  })

  it('explains when the backend cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(getDocuments()).rejects.toThrow(
      'No se pudo conectar con el backend en http://localhost:3000',
    )
  })
})
