import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import {
  MESSAGE_DURABILITY,
  createRequestId,
  readDurabilityResponse,
  writeFlushRequest,
} from './durabilityProtocol'

describe('durability protocol', () => {
  it('writes the exact version 1 FLUSH_REQUEST envelope', () => {
    const requestId = Uint8Array.from({ length: 16 }, (_, index) => index)
    const stateVector = Uint8Array.of(1, 2, 3)
    const decoder = decoding.createDecoder(writeFlushRequest(requestId, stateVector))

    expect(decoding.readVarUint(decoder)).toBe(4)
    expect(decoding.readVarUint(decoder)).toBe(1)
    expect(decoding.readVarUint(decoder)).toBe(0)
    expect(decoding.readVarUint8Array(decoder)).toEqual(requestId)
    expect(decoding.readVarUint8Array(decoder)).toEqual(stateVector)
    expect(decoding.hasContent(decoder)).toBe(false)
  })

  it('creates an exact 16-byte request ID', () => {
    expect(createRequestId()).toHaveLength(16)
  })

  it('reads DURABLE and PERSISTENCE_ERROR responses after message type 4', () => {
    const requestId = Uint8Array.from({ length: 16 }, (_, index) => 15 - index)
    const durable = encoding.createEncoder()
    encoding.writeVarUint(durable, 1)
    encoding.writeVarUint(durable, 1)
    encoding.writeVarUint8Array(durable, requestId)
    encoding.writeVarString(durable, '9007199254740993')
    encoding.writeVarUint8Array(durable, Uint8Array.of(7, 8))
    encoding.writeVarString(durable, '2026-07-22T12:00:00.000Z')

    expect(readDurabilityResponse(decoding.createDecoder(encoding.toUint8Array(durable))))
      .toEqual({
        type: 'durable',
        requestId,
        revision: '9007199254740993',
        durableStateVector: Uint8Array.of(7, 8),
        updatedAt: '2026-07-22T12:00:00.000Z',
      })

    const error = encoding.createEncoder()
    encoding.writeVarUint(error, 1)
    encoding.writeVarUint(error, 2)
    encoding.writeVarUint8Array(error, requestId)
    encoding.writeVarString(error, 'PERSISTENCE_UNAVAILABLE')
    encoding.writeVarUint(error, 1)
    expect(readDurabilityResponse(decoding.createDecoder(encoding.toUint8Array(error))))
      .toEqual({ type: 'error', requestId, code: 'PERSISTENCE_UNAVAILABLE', retryable: true })
  })

  it('rejects malformed IDs, versions, subtypes, retry flags, and trailing bytes', () => {
    expect(() => writeFlushRequest(Uint8Array.of(1), Uint8Array.of())).toThrow('16 bytes')

    const invalid = encoding.createEncoder()
    encoding.writeVarUint(invalid, 2)
    encoding.writeVarUint(invalid, 1)
    encoding.writeVarUint8Array(invalid, new Uint8Array(16))
    expect(() => readDurabilityResponse(decoding.createDecoder(encoding.toUint8Array(invalid))))
      .toThrow('version')
  })

  it('uses the reserved y-websocket custom message type', () => {
    expect(MESSAGE_DURABILITY).toBe(4)
  })
})
