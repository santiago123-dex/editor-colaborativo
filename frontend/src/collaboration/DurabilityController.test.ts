import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import { DurabilityController } from './DurabilityController'

function readRequest(message: Uint8Array) {
  const decoder = decoding.createDecoder(message)
  decoding.readVarUint(decoder)
  decoding.readVarUint(decoder)
  decoding.readVarUint(decoder)
  return {
    requestId: decoding.readVarUint8Array(decoder),
    stateVector: decoding.readVarUint8Array(decoder),
  }
}

describe('DurabilityController', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts clean and ignores updates from the configured remote origin', () => {
    const document = new Y.Doc()
    const provider = {}
    const sent: Uint8Array[] = []
    const states: string[] = []
    const controller = new DurabilityController(document, (message) => sent.push(message), {
      debounceMs: 10,
      ignoredOrigin: provider,
      onStateChange: (state) => states.push(state.status),
    })
    controller.setConnection(true)
    controller.setSynced(true)

    vi.advanceTimersByTime(10)
    expect(states).toEqual(['unchanged'])
    expect(sent).toHaveLength(0)

    document.transact(() => document.getText('content').insert(0, 'Remote'), provider)
    vi.advanceTimersByTime(10)
    expect(states).toEqual(['unchanged'])
    expect(sent).toHaveLength(0)

    document.getText('content').insert(6, ' local')
    expect(states.at(-1)).toBe('pending')
    vi.advanceTimersByTime(10)
    expect(sent).toHaveLength(1)
  })

  it('waits for sync, debounces changes, and only becomes saved after a covering ACK', () => {
    const document = new Y.Doc()
    const sent: Uint8Array[] = []
    const states: string[] = []
    const controller = new DurabilityController(document, (message) => sent.push(message), {
      debounceMs: 300,
      onStateChange: (state) => states.push(state.status),
    })

    document.getText('content').insert(0, 'A')
    vi.advanceTimersByTime(500)
    expect(sent).toHaveLength(0)
    expect(states.at(-1)).toBe('pending')

    controller.setConnection(true)
    controller.setSynced(true)
    vi.advanceTimersByTime(299)
    expect(sent).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(sent).toHaveLength(1)
    expect(states.at(-1)).toBe('saving')

    const request = readRequest(sent[0])
    document.getText('content').insert(1, 'B')
    controller.handleResponse({
      type: 'durable', requestId: request.requestId, revision: '1',
      durableStateVector: request.stateVector, updatedAt: '2026-07-22T12:00:00.000Z',
    })
    expect(states.at(-1)).toBe('pending')

    vi.advanceTimersByTime(300)
    const latest = readRequest(sent[1])
    expect(sent).toHaveLength(2)
    controller.handleResponse({
      type: 'durable', requestId: latest.requestId, revision: '2',
      durableStateVector: Y.encodeStateVector(document), updatedAt: '2026-07-22T12:01:00.000Z',
    })
    expect(states.at(-1)).toBe('saved')
  })

  it('ignores duplicate and late ACKs and retries errors with a new request ID', () => {
    const document = new Y.Doc()
    const sent: Uint8Array[] = []
    let latestState = ''
    const controller = new DurabilityController(document, (message) => sent.push(message), {
      debounceMs: 10,
      onStateChange: (state) => { latestState = state.status },
    })
    controller.setConnection(true)
    controller.setSynced(true)
    document.getText('content').insert(0, 'A')
    vi.advanceTimersByTime(10)
    const first = readRequest(sent[0])
    controller.handleResponse({
      type: 'error', requestId: first.requestId, code: 'PERSISTENCE_UNAVAILABLE', retryable: true,
    })
    expect(latestState).toBe('error')

    controller.retry()
    const second = readRequest(sent[1])
    expect(second.requestId).not.toEqual(first.requestId)
    expect(sent).toHaveLength(2)

    controller.handleResponse({
      type: 'durable', requestId: first.requestId, revision: '1',
      durableStateVector: Y.encodeStateVector(document), updatedAt: '',
    })
    expect(latestState).toBe('saving')
  })

  it('times out a lost ACK, allows retry, and ignores the late ACK', () => {
    const document = new Y.Doc()
    const sent: Uint8Array[] = []
    const states: Array<{ status: string; code?: string; retryable?: boolean }> = []
    const controller = new DurabilityController(document, (message) => sent.push(message), {
      debounceMs: 10,
      ackTimeoutMs: 1_000,
      onStateChange: (state) => states.push(state),
    })
    controller.setConnection(true)
    controller.setSynced(true)
    document.getText('content').insert(0, 'A')
    vi.advanceTimersByTime(10)
    const timedOut = readRequest(sent[0])

    vi.advanceTimersByTime(999)
    expect(states.at(-1)?.status).toBe('saving')
    vi.advanceTimersByTime(1)
    expect(states.at(-1)).toEqual({ status: 'error', code: 'ACK_TIMEOUT', retryable: true })

    controller.retry()
    expect(sent).toHaveLength(2)
    expect(readRequest(sent[1]).requestId).not.toEqual(timedOut.requestId)

    controller.handleResponse({
      type: 'durable', requestId: timedOut.requestId, revision: 'late',
      durableStateVector: Y.encodeStateVector(document), updatedAt: '',
    })
    expect(states.at(-1)?.status).toBe('saving')
  })

  it('cancels the ACK timeout on response, document update, disconnect, and destroy', () => {
    const document = new Y.Doc()
    const sent: Uint8Array[] = []
    const states: string[] = []
    const controller = new DurabilityController(document, (message) => sent.push(message), {
      debounceMs: 10,
      ackTimeoutMs: 1_000,
      onStateChange: (state) => states.push(state.status),
    })
    controller.setConnection(true)
    controller.setSynced(true)

    document.getText('content').insert(0, 'A')
    vi.advanceTimersByTime(10)
    const first = readRequest(sent[0])
    controller.handleResponse({
      type: 'error', requestId: first.requestId, code: 'TEMPORARY', retryable: true,
    })
    vi.advanceTimersByTime(1_000)
    expect(states.filter((state) => state === 'error')).toHaveLength(1)

    controller.retry()
    document.getText('content').insert(1, 'B')
    vi.advanceTimersByTime(10)
    controller.setConnection(false)
    vi.advanceTimersByTime(1_000)
    expect(states.at(-1)).toBe('pending')

    controller.setConnection(true)
    controller.setSynced(true)
    vi.advanceTimersByTime(10)
    controller.destroy()
    vi.advanceTimersByTime(1_000)
    expect(states.at(-1)).toBe('saving')
  })

  it('does not retry an error declared non-retryable', () => {
    const document = new Y.Doc()
    const sent: Uint8Array[] = []
    const controller = new DurabilityController(document, (message) => sent.push(message), {
      debounceMs: 10,
    })
    controller.setConnection(true)
    controller.setSynced(true)
    document.getText('content').insert(0, 'A')
    vi.advanceTimersByTime(10)
    const request = readRequest(sent[0])
    controller.handleResponse({
      type: 'error', requestId: request.requestId, code: 'STATE_NOT_AVAILABLE', retryable: false,
    })

    controller.retry()

    expect(sent).toHaveLength(1)
  })

  it('resends pending content after reconnect and removes its document listener on destroy', () => {
    const document = new Y.Doc()
    const sent: Uint8Array[] = []
    const controller = new DurabilityController(document, (message) => sent.push(message), { debounceMs: 10 })
    controller.setConnection(true)
    controller.setSynced(true)
    document.getText('content').insert(0, 'A')
    vi.advanceTimersByTime(10)
    expect(sent).toHaveLength(1)

    controller.setConnection(false)
    controller.setConnection(true)
    controller.setSynced(true)
    vi.advanceTimersByTime(10)
    expect(sent).toHaveLength(2)

    controller.destroy()
    document.getText('content').insert(1, 'B')
    vi.runAllTimers()
    expect(sent).toHaveLength(2)
  })
})
