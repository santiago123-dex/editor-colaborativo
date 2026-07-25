import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'

export const MESSAGE_DURABILITY = 4
const DURABILITY_VERSION = 1
const FLUSH_REQUEST = 0
const DURABLE = 1
const PERSISTENCE_ERROR = 2

export type DurabilityResponse =
  | {
      type: 'durable'
      requestId: Uint8Array
      revision: string
      durableStateVector: Uint8Array
      updatedAt: string
    }
  | { type: 'error'; requestId: Uint8Array; code: string; retryable: boolean }

function readRequestId(decoder: decoding.Decoder): Uint8Array {
  const requestId = decoding.readVarUint8Array(decoder)
  if (requestId.byteLength !== 16) throw new Error('Durability request ID must be 16 bytes')
  return requestId
}

export function createRequestId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16))
}

export function writeFlushRequest(requestId: Uint8Array, stateVector: Uint8Array): Uint8Array {
  if (requestId.byteLength !== 16) throw new Error('Durability request ID must be 16 bytes')
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_DURABILITY)
  encoding.writeVarUint(encoder, DURABILITY_VERSION)
  encoding.writeVarUint(encoder, FLUSH_REQUEST)
  encoding.writeVarUint8Array(encoder, requestId)
  encoding.writeVarUint8Array(encoder, stateVector)
  return encoding.toUint8Array(encoder)
}

export function readDurabilityResponse(decoder: decoding.Decoder): DurabilityResponse {
  if (decoding.readVarUint(decoder) !== DURABILITY_VERSION) {
    throw new Error('Unsupported durability version')
  }
  const subtype = decoding.readVarUint(decoder)
  const requestId = readRequestId(decoder)

  if (subtype === DURABLE) {
    const response: DurabilityResponse = {
      type: 'durable',
      requestId,
      revision: decoding.readVarString(decoder),
      durableStateVector: decoding.readVarUint8Array(decoder),
      updatedAt: decoding.readVarString(decoder),
    }
    if (decoding.hasContent(decoder)) throw new Error('Trailing durability data')
    return response
  }
  if (subtype === PERSISTENCE_ERROR) {
    const code = decoding.readVarString(decoder)
    const retryFlag = decoding.readVarUint(decoder)
    if (retryFlag !== 0 && retryFlag !== 1) throw new Error('Invalid durability retry flag')
    if (decoding.hasContent(decoder)) throw new Error('Trailing durability data')
    return { type: 'error', requestId, code, retryable: retryFlag === 1 }
  }
  throw new Error('Unsupported durability subtype')
}
