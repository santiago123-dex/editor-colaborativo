import { once } from 'node:events'
import WebSocket from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'

const MESSAGE_SYNC = 0
const baseUrl = process.env.BASE_URL ?? 'http://localhost:3000'

const createDocument = async (): Promise<string> => {
  const response = await fetch(`${baseUrl}/documents`, { method: 'POST' })
  if (!response.ok) throw new Error(`POST /documents failed with HTTP ${response.status}`)
  const body = (await response.json()) as { id: string }
  return body.id
}

const waitUntilContentIs = async (documentId: string, expected: string) => {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/documents/${documentId}`)
    const body = (await response.json()) as { content?: string }
    if (response.ok && body.content === expected) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for the server to receive the Yjs update')
}

const waitUntilLocalContentIs = async (doc: Y.Doc, expected: string) => {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (doc.getText('document-content').toString() === expected) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for the reopened client to synchronize')
}

const connect = async (documentId: string) => {
  const doc = new Y.Doc()
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws/${documentId}`)
  let resolveInitialSync: (() => void) | undefined
  const initialSync = new Promise<void>((resolve) => {
    resolveInitialSync = resolve
  })

  socket.on('message', (data) => {
    const decoder = decoding.createDecoder(new Uint8Array(data as Buffer))
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return

    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.readSyncMessage(decoder, encoder, doc, socket)
    if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder))
    resolveInitialSync?.()
    resolveInitialSync = undefined
  })

  doc.on('update', (update, origin) => {
    if (origin === socket || socket.readyState !== WebSocket.OPEN) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    socket.send(encoding.toUint8Array(encoder))
  })

  await once(socket, 'open')
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(encoder, doc)
  socket.send(encoding.toUint8Array(encoder))
  await initialSync
  return { doc, socket }
}

const documentId = await createDocument()
const marker = `smoke-${Date.now()}`
const first = await connect(documentId)
first.doc.getText('document-content').insert(0, marker)
await waitUntilContentIs(documentId, marker)
first.socket.close()
await once(first.socket, 'close')

const reopened = await connect(documentId)
await waitUntilLocalContentIs(reopened.doc, marker)
const persistedContent = reopened.doc.getText('document-content').toString()
reopened.socket.close()
await once(reopened.socket, 'close')

if (persistedContent !== marker) {
  throw new Error(`Expected persisted content ${marker}, received ${persistedContent}`)
}

console.log(`WebSocket sync and persistence OK for document ${documentId}`)
