import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'

export const MESSAGE_DURABILITY = 4
export const DURABILITY_VERSION = 1
export const FLUSH_REQUEST = 0
export const DURABLE = 1
export const PERSISTENCE_ERROR = 2
export const DURABILITY_RESPONSE_CACHE_LIMIT = 256

export interface FlushRequest {
  requestId: Uint8Array
  clientStateVector: Uint8Array
}

export const readFlushRequest = (decoder: decoding.Decoder): FlushRequest => {
  if (decoding.readVarUint(decoder) !== DURABILITY_VERSION) throw new Error('Unsupported durability version')
  if (decoding.readVarUint(decoder) !== FLUSH_REQUEST) throw new Error('Unsupported durability subtype')
  const requestId = decoding.readVarUint8Array(decoder)
  if (requestId.byteLength !== 16) throw new Error('Invalid durability request id')
  const clientStateVector = decoding.readVarUint8Array(decoder)
  if (decoding.hasContent(decoder)) throw new Error('Trailing durability data')
  return { requestId, clientStateVector }
}

const response = (requestId: Uint8Array, subtype: number): encoding.Encoder => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_DURABILITY)
  encoding.writeVarUint(encoder, DURABILITY_VERSION)
  encoding.writeVarUint(encoder, subtype)
  encoding.writeVarUint8Array(encoder, requestId)
  return encoder
}

export const writeDurable = (
  requestId: Uint8Array,
  revision: number,
  durableStateVector: Uint8Array,
  updatedAt: string,
): Uint8Array => {
  const encoder = response(requestId, DURABLE)
  encoding.writeVarString(encoder, String(revision))
  encoding.writeVarUint8Array(encoder, durableStateVector)
  encoding.writeVarString(encoder, updatedAt)
  return encoding.toUint8Array(encoder)
}

export const writePersistenceError = (
  requestId: Uint8Array,
  code = 'PERSISTENCE_UNAVAILABLE',
  retryable = true,
): Uint8Array => {
  const encoder = response(requestId, PERSISTENCE_ERROR)
  encoding.writeVarString(encoder, code)
  encoding.writeVarUint(encoder, retryable ? 1 : 0)
  return encoding.toUint8Array(encoder)
}
