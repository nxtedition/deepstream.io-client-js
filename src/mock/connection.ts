/**
 * In-memory transport + deepstream server for running the REAL deepstream
 * client without a network.
 *
 * This replaces only the Connection layer (see options.createConnection in
 * client.js): the real record/rpc/event handlers, records, and listeners run
 * unmodified against a small in-memory server that speaks the same wire
 * protocol (topic/action/data message strings).
 *
 * Semantics mirrored from the real server (nxt/deepstream, see
 * record-worker-shard.ts, listener-registry.ts, rpc-handler.ts,
 * event-handler.ts):
 *  - RECORD SUBSCRIBE is answered with UPDATE [name, version, body, 'T'|'F']
 *    where the 4th element is hasProvider as a typed boolean; unwritten
 *    records read as version '0-00000000000000' with body '{}'.
 *  - Client UPDATEs: newer versions are stored and broadcast to all
 *    subscribers INCLUDING the sender (that is how the client clears its
 *    `updating` bookkeeping, record.js:471-473); equal versions are silently
 *    dropped; older versions are echoed back to the sender only (with the
 *    incoming version/body) and not stored.
 *  - Provider (I-versioned) UPDATEs are only honored from the accepted
 *    listener and broadcast as UPDATE [name, version, body, 'T']; a no-op
 *    provider update re-broadcasts SUBSCRIPTION_HAS_PROVIDER [name, 'T'].
 *  - SYNC [token] is echoed back once preceding messages have been processed
 *    (WEAK and STRONG are equivalent in-memory).
 *  - provide() runs the real listen round-trip: LISTEN → SUBSCRIPTION_FOR_
 *    PATTERN_FOUND → client LISTEN_ACCEPT/REJECT → server confirms the chosen
 *    provider with LISTEN_ACCEPT [pattern, name, version]. Withdrawal
 *    promotes another accepted candidate, or broadcasts SUBSCRIPTION_HAS_
 *    PROVIDER [name, 'F'] when none remains.
 *  - RPCs round-trip REQUEST/RESPONSE/REJECTION; the server may route a
 *    REQUEST back to the requesting client (it does not exclude the caller
 *    from providers); REJECTION with no remaining provider yields
 *    RESPONSE [name, id, 'NO_RPC_PROVIDER', typed(true)].
 *  - EVENTs are broadcast excluding the sender (the client emits locally),
 *    so with a single client an emit reaches no one.
 *
 * Timing: messages are queued and pumped on microtasks — never delivered
 *  re-entrantly from inside sendMsg. Connection loss/restore is deterministic
 *  and test-driven via server.dropConnection()/restoreConnection(); there are
 *  no reconnect timers. Use settle() to wait until all in-flight messages
 *  (including the client's 1ms SYNC batching) have quiesced.
 */
import * as C from '../constants/constants.js'
import * as messageBuilder from '../message/message-builder.js'
import * as messageParser from '../message/message-parser.js'
import jsonPath from '@nxtedition/json-path'
import type { DeepstreamClientOptions, DeepstreamMessage } from '../client.js'

// The repo's editor tsconfig has no DOM/node lib; these exist at runtime.
declare function queueMicrotask(callback: () => void): void
declare function setTimeout(callback: (...args: unknown[]) => void, ms?: number): unknown

const SEP: string = C.MESSAGE_PART_SEPERATOR

// Matches the real server's EMPTY_VER/EMPTY_BODY (deepstream constants.ts).
const EMPTY_VERSION = '0-00000000000000'
const EMPTY_BODY = '{}'

// The internal client surface the connection talks to (client.js).
type ClientInternal = {
  _$onMessage(message: DeepstreamMessage): void
  _$onError(topic: string, event: string, msgOrError?: unknown, data?: unknown): void
  emit(name: string, ...args: unknown[]): unknown
}

type EmitterHandler = (...args: unknown[]) => void

// Server-side error sink for convertTyped (never used for valid payloads).
const NOOP_CLIENT = { _$onError() {} }

// Same semantics as utils.compareRev (utils/utils.js:86-114). Inlined so the
// mock does not pull in xxhash-wasm through utils.js.
function compareRev(a: string | null | undefined, b: string | null | undefined): number {
  if (!a) {
    return b ? -1 : 0
  }
  if (!b) {
    return a ? 1 : 0
  }
  if (a === b) {
    return 0
  }
  const av = a[0] === 'I' ? Number.MAX_SAFE_INTEGER : parseInt(a, 10)
  const bv = b[0] === 'I' ? Number.MAX_SAFE_INTEGER : parseInt(b, 10)
  if (av !== bv) {
    return av > bv ? 1 : -1
  }
  const ar = a.slice(a.indexOf('-') + 1)
  const br = b.slice(b.indexOf('-') + 1)
  if (ar !== br) {
    return ar > br ? 1 : -1
  }
  return 0
}

// ---------------------------------------------------------------------------
// MockConnection — drop-in for message/connection.js
// ---------------------------------------------------------------------------

export class MockConnection {
  _server: MockDeepstreamServer
  _client: ClientInternal
  _options: DeepstreamClientOptions
  _state: string = C.CONNECTION_STATE.CLOSED
  _authParams: unknown = null
  _authCallback: ((success: boolean, authData: unknown) => void) | null = null
  _deliberateClose = false
  _handlers = new Map<string, Set<EmitterHandler>>()
  // Reused across deliveries like the real connection (connection.js:25-30).
  _message: DeepstreamMessage = { raw: null, topic: null, action: null, data: [] }

  constructor(
    server: MockDeepstreamServer,
    client: unknown,
    _url: string,
    options: DeepstreamClientOptions | null | undefined,
  ) {
    this._server = server
    this._client = client as ClientInternal
    this._options = options ?? {}
    // The real endpoint opens asynchronously; the client constructor must
    // finish (handlers registered) before any state change is observed.
    queueMicrotask(() => this._connect())
  }

  // Minimal emitter — the client uses on('recv'/'send') chaining (client.js).
  on(name: string, fn: EmitterHandler): this {
    let set = this._handlers.get(name)
    if (!set) {
      this._handlers.set(name, (set = new Set()))
    }
    set.add(fn)
    return this
  }

  off(name: string, fn?: EmitterHandler): this {
    if (fn) {
      this._handlers.get(name)?.delete(fn)
    } else {
      this._handlers.delete(name)
    }
    return this
  }

  emit(name: string, ...args: unknown[]): this {
    const set = this._handlers.get(name)
    if (set) {
      for (const fn of Array.from(set)) {
        fn(...args)
      }
    }
    return this
  }

  get connected(): boolean {
    return this._state === C.CONNECTION_STATE.OPEN
  }

  getState(): string {
    return this._state
  }

  authenticate(
    authParams: unknown,
    callback?: (success: boolean, authData: unknown) => void,
  ): void {
    this._authParams = authParams ?? {}
    this._authCallback = callback ?? null

    if (this._deliberateClose && this._state === C.CONNECTION_STATE.CLOSED) {
      // Re-open after a deliberate close, like connection.js:67-71.
      this._deliberateClose = false
      queueMicrotask(() => this._connect())
    } else if (this._state === C.CONNECTION_STATE.AWAITING_AUTHENTICATION) {
      this._sendAuthParams()
    }
  }

  sendMsg(topic: string, action: string, data?: string[]): boolean {
    return this.send(messageBuilder.getMsg(topic, action, data, false) as string)
  }

  send(message: string): boolean {
    const maxPacketSize = this._options.maxPacketSize ?? 1024 * 1024
    if (message.length > maxPacketSize) {
      this._client._$onError(
        C.TOPIC.CONNECTION,
        C.EVENT.CONNECTION_ERROR,
        new Error(`Packet to big: ${message.length} > ${maxPacketSize}`),
        message.split(SEP).map((x) => x.slice(0, 256)),
      )
      return false
    }

    if (this._state !== C.CONNECTION_STATE.OPEN) {
      return false
    }

    this.emit('send', message)
    this._server._onMessageFromClient(message)
    return true
  }

  close(): void {
    this._deliberateClose = true
    this._setState(C.CONNECTION_STATE.CLOSED)
  }

  _connect(): void {
    if (this._deliberateClose || this._state === C.CONNECTION_STATE.OPEN) {
      return
    }
    // Handshake (CHALLENGE/ACK) elided: the mock server accepts immediately.
    this._setState(C.CONNECTION_STATE.AWAITING_CONNECTION)
    this._setState(C.CONNECTION_STATE.AWAITING_AUTHENTICATION)
    if (this._authParams) {
      this._sendAuthParams()
    }
  }

  _sendAuthParams(): void {
    this._setState(C.CONNECTION_STATE.AUTHENTICATING)
    queueMicrotask(() => {
      if (this._state !== C.CONNECTION_STATE.AUTHENTICATING) {
        return
      }
      const authData = this._server._authenticate(this._authParams)
      // Real order: state OPEN (emits 'connected') first, then the auth
      // callback (connection.js:329-335).
      this._setState(C.CONNECTION_STATE.OPEN)
      this._authCallback?.(true, authData)
    })
  }

  _setState(state: string): void {
    if (this._state === state) {
      return
    }
    this._state = state

    if (state === C.CONNECTION_STATE.RECONNECTING || state === C.CONNECTION_STATE.CLOSED) {
      // In-flight messages are lost with the socket (connection.js:358).
      this._server._onDisconnect()
    }

    this.emit(C.EVENT.CONNECTION_STATE_CHANGED, state)
    this._client.emit(C.EVENT.CONNECTION_STATE_CHANGED, state)

    if (state === C.CONNECTION_STATE.OPEN) {
      this.emit(C.EVENT.CONNECTED, true)
      this._client.emit(C.EVENT.CONNECTED, true)
    } else if (state === C.CONNECTION_STATE.RECONNECTING || state === C.CONNECTION_STATE.CLOSED) {
      this.emit(C.EVENT.CONNECTED, false)
      this._client.emit(C.EVENT.CONNECTED, false)
    }
  }

  _deliver(raw: string): void {
    if (this._state !== C.CONNECTION_STATE.OPEN) {
      return
    }
    // parseMessage mutates the reused message object; null means parse error
    // (already reported through the client).
    if (messageParser.parseMessage(raw, this._client, this._message) === null) {
      return
    }
    this.emit('recv', this._message)
    this._client._$onMessage(this._message)
  }
}

// ---------------------------------------------------------------------------
// Listen negotiation (shared by RECORD and EVENT topics)
// ---------------------------------------------------------------------------

type CandidateState = 'pending' | 'accepted' | 'rejected'

type ListenSubject = {
  subscribed: boolean
  provider: string | null
  candidates: Map<string, CandidateState>
}

class ListenRegistry {
  _topic: string
  _send: (topic: string, action: string, data: string[]) => void
  _listeners = new Map<string, RegExp>()
  _subjects = new Map<string, ListenSubject>()
  // RECORD topic: current record version, appended to the server's
  // LISTEN_ACCEPT confirmation (listener-registry.ts _tryAccept).
  getVersion: ((name: string) => string | null) | null = null
  // RECORD topic: broadcasts SUBSCRIPTION_HAS_PROVIDER [name, 'F'] when the
  // provider withdrew and no accepted candidate could be promoted. The 'T'
  // side travels with provider UPDATEs, not with the accept.
  onProviderLost: ((name: string) => void) | null = null

  constructor(topic: string, send: (topic: string, action: string, data: string[]) => void) {
    this._topic = topic
    this._send = send
  }

  _subject(name: string): ListenSubject {
    let subject = this._subjects.get(name)
    if (!subject) {
      this._subjects.set(
        name,
        (subject = { subscribed: false, provider: null, candidates: new Map() }),
      )
    }
    return subject
  }

  setAudience(name: string, subscribed: boolean): void {
    const subject = this._subject(name)
    if (subject.subscribed === subscribed) {
      return
    }
    subject.subscribed = subscribed

    if (subscribed) {
      for (const [pattern, regex] of this._listeners) {
        this._offer(subject, name, pattern, regex)
      }
    } else {
      // Nobody is interested anymore: tell every engaged listener to stop.
      for (const pattern of subject.candidates.keys()) {
        this._send(this._topic, C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_REMOVED, [pattern, name])
      }
      subject.candidates.clear()
      subject.provider = null
    }
  }

  addListener(pattern: string): void {
    if (this._listeners.has(pattern)) {
      return // client-side provide() already guards duplicates
    }
    const regex = new RegExp(pattern)
    this._listeners.set(pattern, regex)
    for (const [name, subject] of this._subjects) {
      if (subject.subscribed) {
        this._offer(subject, name, pattern, regex)
      }
    }
  }

  removeListener(pattern: string): void {
    if (!this._listeners.delete(pattern)) {
      return
    }
    for (const [name, subject] of this._subjects) {
      if (!subject.candidates.delete(pattern)) {
        continue
      }
      if (subject.provider === pattern) {
        subject.provider = null
        this._promote(subject, name)
      }
    }
  }

  accept(pattern: string, name: string): void {
    const subject = this._subjects.get(name)
    if (!subject || !subject.candidates.has(pattern)) {
      return // stale accept (e.g. after SUBSCRIPTION_FOR_PATTERN_REMOVED)
    }
    subject.candidates.set(pattern, 'accepted')
    if (subject.provider == null) {
      this._choose(subject, name, pattern)
    }
  }

  reject(pattern: string, name: string): void {
    const subject = this._subjects.get(name)
    if (!subject || !subject.candidates.has(pattern)) {
      return // stale reject (listener.stop() after SR)
    }
    subject.candidates.set(pattern, 'rejected')
    if (subject.provider === pattern) {
      subject.provider = null
      this._promote(subject, name)
    }
  }

  hasProvider(name: string): boolean {
    return this._subjects.get(name)?.provider != null
  }

  reset(): void {
    this._listeners.clear()
    this._subjects.clear()
  }

  _offer(subject: ListenSubject, name: string, pattern: string, regex: RegExp): void {
    if (!regex.test(name) || subject.candidates.has(pattern)) {
      return
    }
    subject.candidates.set(pattern, 'pending')
    this._send(this._topic, C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND, [pattern, name])
  }

  _choose(subject: ListenSubject, name: string, pattern: string): void {
    subject.provider = pattern
    const version = this.getVersion?.(name)
    this._send(
      this._topic,
      C.ACTIONS.LISTEN_ACCEPT,
      version != null ? [pattern, name, version] : [pattern, name],
    )
  }

  _promote(subject: ListenSubject, name: string): void {
    for (const [pattern, state] of subject.candidates) {
      if (state === 'accepted') {
        this._choose(subject, name, pattern)
        return
      }
    }
    this.onProviderLost?.(name)
  }
}

// ---------------------------------------------------------------------------
// MockDeepstreamServer
// ---------------------------------------------------------------------------

type ServerRecord = { version: string; body: string }

export class MockDeepstreamServer {
  _connection: MockConnection | null = null
  _records = new Map<string, ServerRecord>()
  _recordListen: ListenRegistry
  _eventListen: ListenRegistry
  _eventSubscriptions = new Set<string>()
  _rpcProviders = new Set<string>()
  // Records with a simulated provider on "another connection" (put/setHasProvider).
  _simulatedProviders = new Set<string>()
  _pendingServerRpcs = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: unknown) => void }
  >()
  _rpcCounter = 0
  _versionCounter = 0
  _sessionCounter = 0
  _toServer: string[] = []
  _toClient: string[] = []
  _pumping = false
  _activity = false
  _pendingSyncFlushes = 0
  _microtaskSync = false
  _authData: Record<string, unknown> | null

  constructor(options?: { authData?: Record<string, unknown> | null }) {
    this._authData = options?.authData ?? null

    this.createConnection = this.createConnection.bind(this)
    this.settle = this.settle.bind(this)

    const send = (topic: string, action: string, data: string[]) =>
      this._sendToClient(topic, action, data)

    this._recordListen = new ListenRegistry(C.TOPIC.RECORD, send)
    this._recordListen.getVersion = (name) => this._records.get(name)?.version ?? null
    this._recordListen.onProviderLost = (name) => {
      if (!this._simulatedProviders.has(name)) {
        this._sendHasProvider(name, false)
      }
    }
    this._eventListen = new ListenRegistry(C.TOPIC.EVENT, send)
  }

  /** Pass as options.createConnection to createDeepstream. Single client. */
  createConnection(client: unknown, url: string, options: DeepstreamClientOptions): MockConnection {
    if (this._connection) {
      throw new Error('MockDeepstreamServer supports a single client')
    }
    this._connection = new MockConnection(this, client, url, options)
    return this._connection
  }

  // ------------------------------ test API ------------------------------

  /**
   * Resolves when message traffic has quiesced.
   *
   * When the client's SYNC batching is microtask-scheduled (the factory
   * injects options.syncSchedule), everything message-producing lives on the
   * microtask queue and settling is timer-free: spin microtask yields until
   * queues, the pump, pending sync flushes and promise chains have gone
   * quiet. Otherwise fall back to 2ms polling windows to cover the client's
   * default 1ms SYNC timer (record-handler.js _sync).
   */
  async settle(): Promise<void> {
    if (this._microtaskSync) {
      let idleYields = 0
      let guard = 0
      while (idleYields < 64) {
        if (++guard > 1_000_000) {
          throw new Error('MockDeepstreamServer.settle: livelock')
        }
        const busy =
          this._activity ||
          this._pumping ||
          this._pendingSyncFlushes > 0 ||
          this._toServer.length > 0 ||
          this._toClient.length > 0
        this._activity = false
        idleYields = busy ? 0 : idleYields + 1
        await new Promise<void>((resolve) => queueMicrotask(resolve))
      }
      return
    }

    let idleRounds = 0
    while (idleRounds < 2) {
      await new Promise((resolve) => setTimeout(resolve, 2))
      if (this._activity || this._toServer.length > 0 || this._toClient.length > 0) {
        this._activity = false
        idleRounds = 0
      } else {
        idleRounds += 1
      }
    }
  }

  /**
   * Microtask-based replacement for the client's 1ms SYNC batching timer.
   * Passed as options.syncSchedule by createMockDeepstream so settle() can
   * account for scheduled-but-not-yet-flushed syncs without waiting on
   * real timers.
   */
  scheduleSync = (flush: () => void): void => {
    this._pendingSyncFlushes += 1
    queueMicrotask(() => {
      this._pendingSyncFlushes -= 1
      this._activity = true
      flush()
    })
  }

  /**
   * Server-originated write, as if another client updated the record.
   * With `provider: true` the write looks like it came from a listener on
   * another connection: INF-version, hasProvider broadcast — the client
   * record ends up in PROVIDER state. Use setHasProvider(name, false) to
   * withdraw again (record goes STALE, like the real flow).
   */
  put(name: string, data: unknown, options?: { version?: string; provider?: boolean }): void {
    const record = this._getOrCreateRecord(name)
    let version = options?.version
    if (!version) {
      if (options?.provider) {
        version = `INF-mock-${++this._versionCounter}`
      } else {
        const current = parseInt(record.version, 10)
        version = `${(Number.isFinite(current) ? current : 0) + 1}-server-${++this._versionCounter}`
      }
    }
    record.version = version
    record.body = jsonPath.stringify(data)
    if (options?.provider) {
      this._simulatedProviders.add(name)
      this._broadcastRecord(name, [name, record.version, record.body, 'T'])
    } else {
      this._broadcastRecord(name, [name, record.version, record.body])
    }
  }

  /**
   * Overrides the hasProvider flag for a record, as if a provider on another
   * connection appeared/withdrew. Broadcasts SUBSCRIPTION_HAS_PROVIDER.
   */
  setHasProvider(name: string, hasProvider: boolean): void {
    if (hasProvider) {
      this._simulatedProviders.add(name)
    } else {
      this._simulatedProviders.delete(name)
    }
    this._sendHasProvider(name, hasProvider)
  }

  /** Current server-side state of a record, or null if it never existed. */
  getRecord(name: string): { version: string; data: unknown } | null {
    const record = this._records.get(name)
    return record ? { version: record.version, data: jsonPath.parse(record.body) } : null
  }

  /** Names the client is currently subscribed to. */
  get subscribedRecords(): string[] {
    const names: string[] = []
    for (const [name, subject] of this._recordListen._subjects) {
      if (subject.subscribed) {
        names.push(name)
      }
    }
    return names
  }

  /** Patterns the client is currently listening on (record topic). */
  get listenPatterns(): string[] {
    return Array.from(this._recordListen._listeners.keys())
  }

  /** Emits an event to the client, as if another client emitted it. */
  emitEvent(name: string, data?: unknown): void {
    if (this._eventSubscriptions.has(name)) {
      this._sendToClient(C.TOPIC.EVENT, C.ACTIONS.EVENT, [
        name,
        messageBuilder.typed(data) as string,
      ])
    }
  }

  /** Calls an RPC provided by the client, as if another client made it. */
  makeRpc(name: string, data?: unknown): Promise<unknown> {
    if (!this._rpcProviders.has(name)) {
      return Promise.reject(
        Object.assign(new Error('NO_RPC_PROVIDER'), { rpcName: name, rpcData: data }),
      )
    }
    const id = `server-rpc-${++this._rpcCounter}`
    return new Promise((resolve, reject) => {
      this._pendingServerRpcs.set(id, { resolve, reject })
      this._sendToClient(C.TOPIC.RPC, C.ACTIONS.REQUEST, [
        name,
        id,
        messageBuilder.typed(data) as string,
      ])
    })
  }

  /**
   * Simulates network loss: the connection goes RECONNECTING (records drop to
   * CLIENT, in-flight RPCs fail with ECONNRESET) and stays there until
   * restoreConnection() is called — no reconnect timers.
   */
  dropConnection(): void {
    this._connection?._setState(C.CONNECTION_STATE.RECONNECTING)
  }

  /** Re-establishes the connection; the client re-auths and resubscribes. */
  restoreConnection(): void {
    this._connection?._connect()
  }

  /**
   * Wipes ALL server-side state — records, subscriptions, listen state, rpc
   * providers, queues — while keeping the connection open. Used by the compat
   * controller's cleanup() between tests; pair it with a client-side reset or
   * the client will resubscribe stale records on next use.
   */
  reset(): void {
    this._toServer.length = 0
    this._toClient.length = 0
    this._records.clear()
    this._recordListen.reset()
    this._eventListen.reset()
    this._eventSubscriptions.clear()
    this._rpcProviders.clear()
    this._simulatedProviders.clear()

    const pending = this._pendingServerRpcs
    this._pendingServerRpcs = new Map()
    for (const { reject } of pending.values()) {
      reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
    }
  }

  // ------------------------------ internals ------------------------------

  _authenticate(_authParams: unknown): unknown {
    this._activity = true
    // Real auth ACK payload is clientData merged with a server session id
    // (connection-endpoint.ts:462-469).
    return { session: `mock-session-${++this._sessionCounter}`, ...(this._authData ?? {}) }
  }

  _onDisconnect(): void {
    this._toServer.length = 0
    this._toClient.length = 0
    // All connection-scoped state dies with the socket; record data persists.
    this._recordListen.reset()
    this._eventListen.reset()
    this._eventSubscriptions.clear()
    this._rpcProviders.clear()

    const pending = this._pendingServerRpcs
    this._pendingServerRpcs = new Map()
    for (const { reject } of pending.values()) {
      reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
    }
  }

  _onMessageFromClient(raw: string): void {
    this._activity = true
    this._toServer.push(raw)
    this._schedulePump()
  }

  _sendToClient(topic: string, action: string, data: string[]): void {
    if (!this._connection || !this._connection.connected) {
      return
    }
    this._activity = true
    this._toClient.push(messageBuilder.getMsg(topic, action, data, false) as string)
    this._schedulePump()
  }

  _schedulePump(): void {
    if (this._pumping) {
      return
    }
    this._pumping = true
    queueMicrotask(() => {
      try {
        let guard = 0
        while (this._toServer.length > 0 || this._toClient.length > 0) {
          if (++guard > 100_000) {
            throw new Error('MockDeepstreamServer: message livelock')
          }
          if (this._toClient.length > 0) {
            // Deliver pending replies before handling the next request so
            // causal order is preserved.
            this._connection?._deliver(this._toClient.shift() as string)
          } else {
            this._handle(this._toServer.shift() as string)
          }
        }
      } finally {
        this._pumping = false
      }
    })
  }

  _handle(raw: string): void {
    const parts = raw.split(SEP)
    const topic = parts[0]
    const action = parts[1]
    const data = parts.slice(2)

    if (topic === C.TOPIC.RECORD) {
      this._handleRecord(action, data)
    } else if (topic === C.TOPIC.RPC) {
      this._handleRpc(action, data)
    } else if (topic === C.TOPIC.EVENT) {
      this._handleEvent(action, data)
    }
  }

  _getOrCreateRecord(name: string): ServerRecord {
    let record = this._records.get(name)
    if (!record) {
      this._records.set(name, (record = { version: EMPTY_VERSION, body: EMPTY_BODY }))
    }
    return record
  }

  _hasProvider(name: string): boolean {
    return this._recordListen.hasProvider(name) || this._simulatedProviders.has(name)
  }

  _sendHasProvider(name: string, hasProvider: boolean): void {
    if (this._recordListen._subjects.get(name)?.subscribed) {
      this._sendToClient(C.TOPIC.RECORD, C.ACTIONS.SUBSCRIPTION_HAS_PROVIDER, [
        name,
        messageBuilder.typed(hasProvider) as string,
      ])
    }
  }

  /** Broadcasts an UPDATE to subscribers (which includes the sender). */
  _broadcastRecord(name: string, data: string[]): void {
    if (this._recordListen._subjects.get(name)?.subscribed) {
      this._sendToClient(C.TOPIC.RECORD, C.ACTIONS.UPDATE, data)
    }
  }

  _handleRecord(action: string, data: string[]): void {
    if (action === C.ACTIONS.SUBSCRIBE) {
      const [name] = data
      const record = this._getOrCreateRecord(name)
      // Read reply: hasProvider always present as typed boolean
      // (record-worker-shard.ts onSubscriptionAdded).
      this._sendToClient(C.TOPIC.RECORD, C.ACTIONS.UPDATE, [
        name,
        record.version,
        record.body,
        messageBuilder.typed(this._hasProvider(name)) as string,
      ])
      this._recordListen.setAudience(name, true)
    } else if (action === C.ACTIONS.UNSUBSCRIBE) {
      this._recordListen.setAudience(data[0], false)
    } else if (action === C.ACTIONS.PUT) {
      const [name, version, body] = data
      const record = this._getOrCreateRecord(name)
      record.version = version
      record.body = body ?? 'null'
      this._broadcastRecord(name, [name, record.version, record.body])
    } else if (action === C.ACTIONS.UPDATE) {
      const [name, version, body] = data
      const record = this._getOrCreateRecord(name)
      if (version.charAt(0) === 'I') {
        // Provider updates are only honored from the accepted listener
        // (record-worker-shard.ts:584-601); with a single client, that means
        // the record must currently have a provider.
        const subject = this._recordListen._subjects.get(name)
        if (subject?.provider != null) {
          if (compareRev(version, record.version) !== 0) {
            record.version = version
            record.body = body ?? 'null'
            this._broadcastRecord(name, [name, record.version, record.body, 'T'])
          } else {
            // No-op provider update: re-affirm hasProvider instead.
            this._sendHasProvider(name, true)
          }
        }
      } else {
        const cmp = compareRev(version, record.version)
        if (cmp > 0) {
          record.version = version
          record.body = body ?? 'null'
          this._broadcastRecord(name, [name, record.version, record.body])
        } else if (cmp < 0) {
          // Stale write: ack the sender only, echoing the incoming
          // version/body so its `updating` bookkeeping clears
          // (record-worker-shard.ts:570-572). Equal versions are silent.
          this._sendToClient(C.TOPIC.RECORD, C.ACTIONS.UPDATE, [name, version, body ?? 'null'])
        }
      }
    } else if (action === C.ACTIONS.SYNC) {
      this._sendToClient(C.TOPIC.RECORD, C.ACTIONS.SYNC, [data[0]])
    } else if (action === C.ACTIONS.LISTEN) {
      this._recordListen.addListener(data[0])
    } else if (action === C.ACTIONS.UNLISTEN) {
      this._recordListen.removeListener(data[0])
    } else if (action === C.ACTIONS.LISTEN_ACCEPT) {
      this._recordListen.accept(data[0], data[1])
    } else if (action === C.ACTIONS.LISTEN_REJECT) {
      this._recordListen.reject(data[0], data[1])
    }
  }

  _handleRpc(action: string, data: string[]): void {
    if (action === C.ACTIONS.SUBSCRIBE) {
      this._rpcProviders.add(data[0])
    } else if (action === C.ACTIONS.UNSUBSCRIBE) {
      this._rpcProviders.delete(data[0])
    } else if (action === C.ACTIONS.REQUEST) {
      const [name, id, typedData] = data
      if (this._rpcProviders.has(name)) {
        // Route to the provider — with a single client that is the caller
        // itself, which the real server allows too.
        this._sendToClient(C.TOPIC.RPC, C.ACTIONS.REQUEST, [name, id, typedData])
      } else {
        this._sendToClient(C.TOPIC.RPC, C.ACTIONS.RESPONSE, [
          name,
          id,
          'NO_RPC_PROVIDER',
          messageBuilder.typed(true) as string,
        ])
      }
    } else if (action === C.ACTIONS.RESPONSE) {
      const [name, id, payload, errorFlag] = data
      const pending = this._pendingServerRpcs.get(id)
      if (pending) {
        this._pendingServerRpcs.delete(id)
        if (errorFlag) {
          pending.reject(Object.assign(new Error(payload), { rpcName: name, rpcId: id }))
        } else {
          pending.resolve(messageParser.convertTyped(payload, NOOP_CLIENT))
        }
      } else {
        this._sendToClient(C.TOPIC.RPC, C.ACTIONS.RESPONSE, data)
      }
    } else if (action === C.ACTIONS.REJECTION) {
      const [name, id] = data
      const pending = this._pendingServerRpcs.get(id)
      if (pending) {
        this._pendingServerRpcs.delete(id)
        pending.reject(Object.assign(new Error('NO_RPC_PROVIDER'), { rpcName: name, rpcId: id }))
      } else {
        // No other provider to retry: the caller gets NO_RPC_PROVIDER.
        this._sendToClient(C.TOPIC.RPC, C.ACTIONS.RESPONSE, [
          name,
          id,
          'NO_RPC_PROVIDER',
          messageBuilder.typed(true) as string,
        ])
      }
    }
  }

  _handleEvent(action: string, data: string[]): void {
    if (action === C.ACTIONS.SUBSCRIBE) {
      this._eventSubscriptions.add(data[0])
      this._eventListen.setAudience(data[0], true)
    } else if (action === C.ACTIONS.UNSUBSCRIBE) {
      this._eventSubscriptions.delete(data[0])
      this._eventListen.setAudience(data[0], false)
    } else if (action === C.ACTIONS.EVENT) {
      // The sender is excluded from event broadcasts (it emits locally) and
      // there are no other clients — nothing to do.
    } else if (action === C.ACTIONS.LISTEN) {
      this._eventListen.addListener(data[0])
    } else if (action === C.ACTIONS.UNLISTEN) {
      this._eventListen.removeListener(data[0])
    } else if (action === C.ACTIONS.LISTEN_ACCEPT) {
      this._eventListen.accept(data[0], data[1])
    } else if (action === C.ACTIONS.LISTEN_REJECT) {
      this._eventListen.reject(data[0], data[1])
    }
  }
}
