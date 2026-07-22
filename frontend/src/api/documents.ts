export interface DocumentSummary {
  id: string
  createdAt: string
  title: string
}

export interface CreatedDocument {
  id: string
  createdAt: string
}

// Keeping the backend address here prevents UI components from knowing HTTP details.
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

async function request<T>(path: string, errorMessage: string, init?: RequestInit): Promise<T> {
  let response: Response

  try {
    response = init
      ? await fetch(`${API_URL}${path}`, init)
      : await fetch(`${API_URL}${path}`)
  } catch {
    // Network errors do not include the backend URL, so expose an actionable message to the UI.
    throw new Error(`No se pudo conectar con el backend en ${API_URL}`)
  }

  if (!response.ok) {
    throw new Error(errorMessage)
  }

  return response.json() as Promise<T>
}

export function getDocuments(): Promise<DocumentSummary[]> {
  return request('/documents', 'No se pudieron cargar los documentos')
}

export function createDocument(): Promise<CreatedDocument> {
  return request('/documents', 'No se pudo crear el documento', { method: 'POST' })
}
