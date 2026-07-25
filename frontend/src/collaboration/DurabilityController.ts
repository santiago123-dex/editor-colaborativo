import * as Y from 'yjs'
import {
  createRequestId,
  type DurabilityResponse,
  writeFlushRequest,
} from './durabilityProtocol'

export type PersistenceState =
  | { status: 'unchanged' | 'pending' | 'saving' | 'saved' }
  | { status: 'error'; code: string; retryable: boolean }

interface DurabilityControllerOptions {
  debounceMs?: number
  ackTimeoutMs?: number
  ignoredOrigin?: unknown
  shouldIgnoreOrigin?: (origin: unknown) => boolean
  onStateChange?: (state: PersistenceState) => void
}

interface PendingRequest {
  requestId: Uint8Array
  stateVector: Uint8Array
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function stateVectorCovers(candidate: Uint8Array, current: Uint8Array): boolean {
  const candidateClocks = Y.decodeStateVector(candidate)
  for (const [clientId, clock] of Y.decodeStateVector(current)) {
    if ((candidateClocks.get(clientId) ?? 0) < clock) return false
  }
  return true
}

export class DurabilityController {
  private readonly debounceMs: number
  private readonly ackTimeoutMs: number
  private readonly shouldIgnoreOrigin: (origin: unknown) => boolean
  private readonly onStateChange: (state: PersistenceState) => void
  private connected = false
  private synced = false
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private ackTimer: ReturnType<typeof setTimeout> | undefined
  private pendingRequest: PendingRequest | undefined
  private destroyed = false
  private state: PersistenceState = { status: 'unchanged' }

  private readonly handleDocumentUpdate = (_update: Uint8Array, origin: unknown) => {
    if (this.destroyed || this.shouldIgnoreOrigin(origin)) return
    this.dirty = true
    this.clearPendingRequest()
    this.emit({ status: 'pending' })
    this.scheduleFlush()
  }

  constructor(
    private readonly document: Y.Doc,
    private readonly send: (message: Uint8Array) => void,
    options: DurabilityControllerOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 500
    this.ackTimeoutMs = options.ackTimeoutMs ?? 10_000
    this.shouldIgnoreOrigin = options.shouldIgnoreOrigin
      ?? ((origin) => options.ignoredOrigin !== undefined && origin === options.ignoredOrigin)
    this.onStateChange = options.onStateChange ?? (() => {})
    document.on('update', this.handleDocumentUpdate)
    this.emit({ status: 'unchanged' })
  }

  setConnection(connected: boolean): void {
    this.connected = connected
    if (!connected) {
      this.synced = false
      this.clearPendingRequest()
      this.clearTimer()
      if (this.dirty) this.emit({ status: 'pending' })
    }
  }

  setSynced(synced: boolean): void {
    this.synced = synced
    if (synced) this.scheduleFlush()
    else {
      this.clearPendingRequest()
      if (this.dirty) this.emit({ status: 'pending' })
    }
  }

  handleResponse(response: DurabilityResponse): void {
    if (!this.pendingRequest || !sameBytes(response.requestId, this.pendingRequest.requestId)) return
    this.clearPendingRequest()

    if (response.type === 'error') {
      this.emit({ status: 'error', code: response.code, retryable: response.retryable })
      return
    }

    const currentStateVector = Y.encodeStateVector(this.document)
    if (stateVectorCovers(response.durableStateVector, currentStateVector)) {
      this.dirty = false
      this.emit({ status: 'saved' })
      return
    }

    this.dirty = true
    this.emit({ status: 'pending' })
    this.scheduleFlush()
  }

  retry(): void {
    if (
      !this.dirty ||
      this.destroyed ||
      (this.state.status === 'error' && !this.state.retryable)
    ) return
    this.clearPendingRequest()
    this.clearTimer()
    if (this.connected && this.synced) this.flush()
    else this.emit({ status: 'pending' })
  }

  handleInvalidResponse(): void {
    if (!this.dirty || this.destroyed) return
    this.clearPendingRequest()
    this.emit({ status: 'error', code: 'INVALID_RESPONSE', retryable: true })
  }

  destroy(): void {
    this.destroyed = true
    this.clearTimer()
    this.clearPendingRequest()
    this.document.off('update', this.handleDocumentUpdate)
  }

  private emit(state: PersistenceState): void {
    this.state = state
    this.onStateChange(state)
  }

  private scheduleFlush(): void {
    if (!this.dirty || !this.connected || !this.synced || this.pendingRequest || this.destroyed) return
    this.clearTimer()
    this.timer = setTimeout(() => this.flush(), this.debounceMs)
  }

  private flush(): void {
    this.clearTimer()
    if (!this.dirty || !this.connected || !this.synced || this.destroyed) return
    const pendingRequest = {
      requestId: createRequestId(),
      stateVector: Y.encodeStateVector(this.document),
    }
    this.pendingRequest = pendingRequest
    try {
      this.send(writeFlushRequest(pendingRequest.requestId, pendingRequest.stateVector))
      this.emit({ status: 'saving' })
      this.ackTimer = setTimeout(() => {
        if (this.pendingRequest !== pendingRequest || this.destroyed) return
        this.clearPendingRequest()
        this.emit({ status: 'error', code: 'ACK_TIMEOUT', retryable: true })
      }, this.ackTimeoutMs)
    } catch {
      this.clearPendingRequest()
      this.emit({ status: 'error', code: 'CONNECTION_UNAVAILABLE', retryable: true })
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private clearPendingRequest(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = undefined
    this.pendingRequest = undefined
  }
}
