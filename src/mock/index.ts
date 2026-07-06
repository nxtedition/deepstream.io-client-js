/**
 * In-memory mock of the deepstream client.
 *
 * Known differences from the real client:
 *  - No network: getConnectionState() always returns 'OPEN'; login()/close() are no-ops and
 *    connection-loss behaviors (records dropping to CLIENT, RPC ECONNRESET, resubscribes)
 *    do not exist.
 *  - event.provide() throws — not implemented. As a consequence event stats.listeners is
 *    always 0 (the real client counts provide() listeners there, not subscriptions).
 *  - Records are never pruned: stats.records never shrinks and refs are bookkeeping only.
 *  - set()/update() apply synchronously ("instant server ack"): there are no patching or
 *    updating phases, so stats.updating/patching are always 0 and written records jump
 *    straight to SERVER state.
 *  - record.provide() invokes provider callbacks eagerly (at getRecord()/provide() time)
 *    instead of through the server listen round-trip; when several patterns match, the last
 *    registered provider wins.
 *  - Client-set versions are `${n}-mock`; provider versions are `INF-<hash>` like the real
 *    listeners send.
 *  - Errors that the real client routes through client.on('error') (PROVIDER_EXISTS,
 *    NOT_PROVIDING, 'cannot set', 'cannot update', ...) throw synchronously here — the same
 *    thing the real client does when no 'error' listener is registered (client.js:100-109).
 *  - event.once() mirrors the real runtime: the callback receives (name, data). Note the
 *    real implementation contradicts event-handler.d.ts here, which declares (data) only.
 */
import type {
  DeepstreamClient,
  DsRecord,
  EventHandler,
  Get,
  RecordHandler,
  RpcHandler,
} from '../client.js'
import type {
  UpdateOptions,
  WhenOptions,
  ObserveOptions,
  ObserveOptionsWithPath,
} from '../record/record.js'
import type { RecordStats, ProvideOptions } from '../record/record-handler.js'
import type { RpcStats, RpcMethodDef } from '../rpc/rpc-handler.js'
import type { EventStats } from '../event/event-handler.js'
import jsonPath from '@nxtedition/json-path'
import { BehaviorSubject, firstValueFrom, Observable, Subscription } from 'rxjs'
import * as rxjs from 'rxjs'
import type RpcResponse from '../rpc/rpc-response.js'

type Lookup<Table, Key> = Key extends keyof Table ? Table[Key] : unknown

const EMPTY = Object.freeze({})
const EMPTY_ARR = Object.freeze([])

const VOID = 0
const CLIENT = 1
const SERVER = 2
const STALE = 3
const PROVIDER = 4

const RECORD_STATE_NAME: Record<number, string> = {
  0: 'VOID',
  1: 'CLIENT',
  2: 'SERVER',
  3: 'STALE',
  4: 'PROVIDER',
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

type Disposer = {
  (): void
  [Symbol.dispose](): void
}

function makeDisposer(fn: () => void): Disposer {
  const d = fn as Disposer
  d[Symbol.dispose] = fn
  return d
}

// Matches utils.AbortError in the real client (utils/utils.js:116-122).
class AbortError extends Error {
  code = 'ABORT_ERR'
  constructor() {
    super('The operation was aborted')
    this.name = 'AbortError'
  }
}

// Same effective check as utils.isPlainObject (utils/utils.js:38-57).
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    return false
  }
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

// The real listeners hash the stringified payload with xxhash64 to build
// `INF-<hash>` provider versions (legacy-listener.js:170-181). A djb2 hash is
// enough for the mock — it only needs to be deterministic per payload.
function hashString(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return h.toString(16)
}

function isValidPath(path: unknown): boolean {
  return (
    (typeof path === 'string' && path.length > 0 && !path.startsWith('_')) ||
    (Array.isArray(path) && path.length > 0 && !String(path[0]).startsWith('_'))
  )
}

function timeoutError(message: string, props: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code: 'ETIMEDOUT' }, props)
}

type ObservableLike = { subscribe: (...args: unknown[]) => unknown }

// The real listeners duck-type provider values (`typeof value$.subscribe ===
// 'function'`, legacy-listener.js:114, 189) — never instanceof, which would
// break for observables from a foreign rxjs copy.
function isObservableLike(value: unknown): value is ObservableLike {
  return value != null && typeof (value as { subscribe?: unknown }).subscribe === 'function'
}

function toNativeObservable(value: ObservableLike): Observable<unknown> {
  return value instanceof Observable
    ? value
    : new Observable((subscriber) => {
        const sub = value.subscribe(subscriber) as { unsubscribe?: () => void } | null
        return () => sub?.unsubscribe?.()
      })
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export class MockRpcResponse<T = unknown> implements RpcResponse<T> {
  completed = false
  private _resolve: (data: T) => void
  private _reject: (err: unknown) => void

  constructor(resolve: (data: T) => void, reject: (err: unknown) => void) {
    this._resolve = resolve
    this._reject = reject
  }

  send(data: T): void {
    if (this.completed) {
      throw new Error('RPC already completed')
    }
    this.completed = true
    this._resolve(data)
  }

  error(err: Error | string): void {
    if (this.completed) {
      throw new Error('RPC already completed')
    }
    this.completed = true
    this._reject(err)
  }

  reject(): void {
    if (this.completed) {
      throw new Error('RPC already completed')
    }
    this.completed = true
    // Real: reject() sends a REJECTION (rpc-response.js:11-18); with no other
    // provider the server answers the caller with a NO_RPC_PROVIDER error.
    this._reject(new Error('NO_RPC_PROVIDER'))
  }
}

export class MockRpcHandler<
  Methods extends Record<string, RpcMethodDef> = Record<string, RpcMethodDef>,
> implements RpcHandler<Methods> {
  private _providers = new Map<
    string,
    (data: unknown, response: MockRpcResponse<unknown>) => unknown
  >()
  private _pendingRpcs = 0
  private _rpcCounter = 0

  constructor() {
    // Real: bound so destructured usage works (rpc-handler.js:15-17).
    this.provide = this.provide.bind(this) as typeof this.provide
    this.unprovide = this.unprovide.bind(this) as typeof this.unprovide
    this.make = this.make.bind(this) as typeof this.make
  }

  get connected(): boolean {
    return true
  }

  get stats(): RpcStats {
    return { listeners: this._providers.size, rpcs: this._pendingRpcs }
  }

  provide<Name extends string & keyof Methods>(
    name: Name,
    callback: (data: Methods[Name][0], response: MockRpcResponse<Methods[Name][1]>) => unknown,
  ): Disposer
  provide(
    name: string,
    callback: (data: unknown, response: MockRpcResponse<unknown>) => unknown,
  ): Disposer
  provide(
    name: string,
    callback: (data: unknown, response: MockRpcResponse<unknown>) => unknown,
  ): Disposer {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('invalid argument name')
    }
    if (typeof callback !== 'function') {
      throw new Error('invalid argument callback')
    }
    if (this._providers.has(name)) {
      // Real: PROVIDER_EXISTS is routed through client error handling, which
      // throws when no 'error' listener is registered (rpc-handler.js:46-49 +
      // client.js:100-109). The first provider stays active.
      throw Object.assign(new Error(name), { event: 'PROVIDER_EXISTS' })
    }
    this._providers.set(name, callback)
    return makeDisposer(() => this.unprovide(name))
  }

  unprovide<Name extends string & keyof Methods>(name: Name): void
  unprovide(name: string): void
  unprovide(name: string): void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('invalid argument name')
    }
    if (!this._providers.has(name)) {
      // Real: NOT_PROVIDING error (rpc-handler.js:70-73), thrown without an
      // 'error' listener.
      throw Object.assign(new Error(name), { event: 'NOT_PROVIDING' })
    }
    this._providers.delete(name)
  }

  make<Name extends string & keyof Methods>(
    name: Name,
    data: Methods[Name][0],
  ): Promise<Methods[Name][1]>
  make<Name extends string & keyof Methods>(
    name: Name,
    data: Methods[Name][0],
    callback: (error: unknown, result: Methods[Name][1]) => void,
  ): void
  make(name: string, data?: unknown): Promise<unknown>
  make(name: string, data: unknown, callback: (error: unknown, result: unknown) => void): void
  make(
    name: string,
    data?: unknown,
    callback?: (error: unknown, result: unknown) => void,
  ): Promise<unknown> | void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('invalid argument name')
    }
    if (callback !== undefined && typeof callback !== 'function') {
      throw new Error('invalid argument callback')
    }

    const rpcId = `rpc-${++this._rpcCounter}`

    // Real: the caller always receives `Object.assign(new Error(message),
    // { rpcId, rpcName, rpcData })` — only the error message crosses the wire
    // (rpc-handler.js:148-162, rpc-response.js:20-32).
    const wrapError = (err: unknown) =>
      Object.assign(new Error(err instanceof Error ? err.message : String(err)), {
        rpcId,
        rpcName: name,
        rpcData: data,
      })

    const provider = this._providers.get(name)
    if (!provider) {
      const err = wrapError(new Error('NO_RPC_PROVIDER'))
      if (callback) {
        callback(err, undefined)
        return
      }
      return Promise.reject(err)
    }

    let resolve_: ((val: unknown) => void) | undefined
    let reject_: ((err: unknown) => void) | undefined
    let promise: Promise<unknown> | undefined

    if (!callback) {
      promise = new Promise<unknown>((resolve, reject) => {
        resolve_ = resolve
        reject_ = reject
      })
    }

    const done = (err: unknown, val?: unknown) => {
      this._pendingRpcs--
      const wrapped = err == null ? null : wrapError(err)
      if (callback) {
        callback(wrapped, val)
      } else if (wrapped) {
        reject_!(wrapped)
      } else {
        resolve_!(val)
      }
    }

    this._pendingRpcs++
    const response = new MockRpcResponse<unknown>(
      (val) => done(null, val),
      (err) => done(err),
    )

    let returnValue: unknown
    try {
      returnValue = provider(data, response)
    } catch (err) {
      if (!response.completed) {
        response.error(err as Error)
      }
      return promise
    }

    if (!response.completed) {
      Promise.resolve(returnValue)
        .then((val) => {
          if (!response.completed) {
            response.send(val as never)
          }
        })
        .catch((err: unknown) => {
          if (!response.completed) {
            response.error(err as Error)
          }
        })
    }

    return promise
  }

  cleanup(): void {
    this._providers.clear()
    this._pendingRpcs = 0
    this._rpcCounter = 0
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export class MockEventHandler implements EventHandler {
  private _subscriptions = new Map<string, Set<(data: unknown) => void>>()
  private _emittedCount = 0

  constructor() {
    // Real: bound so destructured usage works (event-handler.js:19-23).
    this.subscribe = this.subscribe.bind(this)
    this.unsubscribe = this.unsubscribe.bind(this)
    this.observe = this.observe.bind(this)
    this.provide = this.provide.bind(this)
    this.emit = this.emit.bind(this)
  }

  get connected(): boolean {
    return true
  }

  get stats(): EventStats {
    // Real: `listeners` counts provide() listeners and `events` counts distinct
    // subscribed names (event-handler.js:34-42). The mock has no event.provide()
    // so listeners is always 0.
    return {
      emitted: this._emittedCount,
      listeners: 0,
      events: this._subscriptions.size,
    }
  }

  emit(name: string, data?: unknown): void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('invalid argument name')
    }
    this._emittedCount++
    const subs = this._subscriptions.get(name)
    if (subs) {
      // Iterate a snapshot like component-emitter2 does, so callbacks may
      // (un)subscribe during emit without affecting this delivery.
      for (const cb of Array.from(subs)) {
        cb(data)
      }
    }
  }

  subscribe(name: string, callback: (data: unknown) => void): void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('invalid argument name')
    }
    if (typeof callback !== 'function') {
      throw new Error('invalid argument callback')
    }
    let subs = this._subscriptions.get(name)
    if (!subs) {
      this._subscriptions.set(name, (subs = new Set()))
    }
    subs.add(callback)
  }

  unsubscribe(name: string, callback?: (data: unknown) => void): void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('invalid argument name')
    }
    if (callback !== undefined && typeof callback !== 'function') {
      throw new Error('invalid argument callback')
    }
    if (!callback) {
      this._subscriptions.delete(name)
      return
    }
    const subs = this._subscriptions.get(name)
    if (subs) {
      subs.delete(callback)
      if (subs.size === 0) {
        this._subscriptions.delete(name)
      }
    }
  }

  on(name: string, callback: (data: unknown) => void): this {
    this.subscribe(name, callback)
    return this
  }

  once(name: string, callback: (data: unknown) => void): this {
    // Mirrors the real client (event-handler.js:79-86): the wrapper passes the
    // event NAME as the first argument — `callback(name, ...args)` — and since
    // the wrapper is anonymous, off(name, callback) cannot remove a pending
    // once() subscription. (The real implementation contradicts its own d.ts
    // here; the mock follows the runtime behavior.)
    const fn = (data: unknown) => {
      this.unsubscribe(name, fn)
      ;(callback as (name: string, data: unknown) => void)(name, data)
    }
    this.subscribe(name, fn)
    return this
  }

  off(name: string, callback: (data: unknown) => void): this {
    this.unsubscribe(name, callback)
    return this
  }

  observe<Data = unknown>(name: string): Observable<Data> {
    return new Observable<Data>((observer) => {
      const cb = (data: unknown) => observer.next(data as Data)
      this.subscribe(name, cb)
      return () => this.unsubscribe(name, cb)
    })
  }

  provide(_pattern: string, _callback: (name: string) => void, _options: unknown): Disposer {
    throw new Error('MockEventHandler.provide() is not implemented')
  }

  cleanup(): void {
    this._subscriptions.clear()
    this._emittedCount = 0
  }
}

/**
 * Controller for the mock client, exposing internal methods for testing purposes.
 */
export class MockDeepstreamClientController<
  Records extends Record<string, unknown> = Record<string, unknown>,
  Methods extends Record<string, RpcMethodDef> = Record<string, RpcMethodDef>,
> {
  private client: MockDeepstreamClient<Records, Methods>
  constructor(client: MockDeepstreamClient<Records, Methods>) {
    this.client = client
  }

  public setRecordState(name: string, state: number, data?: unknown): void {
    const record = this.client.record.getRecord(name) as unknown as MockRecord<unknown>
    record.unref() // getRecord refs like the real client; keep the controller neutral
    record.setState(state, data)
  }

  public cleanup(): void {
    this.client.cleanup()
  }

  public getRecordSubscriptions(name: string) {
    const record = this.client.record.getRecord(name) as unknown as MockRecord<unknown>
    record.unref()
    return record.subscriptions
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class MockDeepstreamClient<
  Records extends Record<string, unknown> = Record<string, unknown>,
  Methods extends Record<string, RpcMethodDef> = Record<string, RpcMethodDef>,
> implements DeepstreamClient<Records, Methods> {
  public readonly record: MockRecordHandler<Records> = new MockRecordHandler()
  public readonly rpc: MockRpcHandler<Methods> = new MockRpcHandler()
  public readonly event: MockEventHandler = new MockEventHandler()

  private _nuidCounter = 0
  private _listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  static create = function create<
    Records extends Record<string, unknown>,
    Methods extends Record<string, RpcMethodDef>,
  >(): {
    client: DeepstreamClient<Records, Methods>
    controller: MockDeepstreamClientController<Records, Methods>
  } {
    const client = new MockDeepstreamClient<Records, Methods>()
    return {
      client,
      controller: new MockDeepstreamClientController(client),
    }
  }

  private constructor() {}

  CONSTANTS = {
    RECORD_STATE: { VOID: 0, CLIENT: 1, SERVER: 2, STALE: 3, PROVIDER: 4 },
    CONNECTION_STATE: {
      CLOSED: 'CLOSED',
      AWAITING_CONNECTION: 'AWAITING_CONNECTION',
      CHALLENGING: 'CHALLENGING',
      AWAITING_AUTHENTICATION: 'AWAITING_AUTHENTICATION',
      AUTHENTICATING: 'AUTHENTICATING',
      OPEN: 'OPEN',
      ERROR: 'ERROR',
      RECONNECTING: 'RECONNECTING',
    },
    EVENT: {
      CONNECTION_ERROR: 'connectionError',
      CONNECTION_STATE_CHANGED: 'connectionStateChanged',
      CONNECTED: 'connected',
      MAX_RECONNECTION_ATTEMPTS_REACHED: 'MAX_RECONNECTION_ATTEMPTS_REACHED',
      CONNECTION_AUTHENTICATION_TIMEOUT: 'CONNECTION_AUTHENTICATION_TIMEOUT',
      NO_RPC_PROVIDER: 'NO_RPC_PROVIDER',
      RPC_ERROR: 'RPC_ERROR',
      TIMEOUT: 'TIMEOUT',
      UNSOLICITED_MESSAGE: 'UNSOLICITED_MESSAGE',
      MESSAGE_DENIED: 'MESSAGE_DENIED',
      NOT_CONNECTED: 'NOT_CONNECTED',
      MESSAGE_PARSE_ERROR: 'MESSAGE_PARSE_ERROR',
      NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
      MESSAGE_PERMISSION_ERROR: 'MESSAGE_PERMISSION_ERROR',
      LISTENER_EXISTS: 'LISTENER_EXISTS',
      PROVIDER_ERROR: 'PROVIDER_ERROR',
      CACHE_ERROR: 'CACHE_ERROR',
      UPDATE_ERROR: 'UPDATE_ERROR',
      USER_ERROR: 'USER_ERROR',
      REF_ERROR: 'REF_ERROR',
      PROVIDER_EXISTS: 'PROVIDER_EXISTS',
      NOT_LISTENING: 'NOT_LISTENING',
      NOT_PROVIDING: 'NOT_PROVIDING',
      LISTENER_ERROR: 'LISTENER_ERROR',
      TOO_MANY_AUTH_ATTEMPTS: 'TOO_MANY_AUTH_ATTEMPTS',
      IS_CLOSED: 'IS_CLOSED',
      RECORD_NOT_FOUND: 'RECORD_NOT_FOUND',
      NOT_SUBSCRIBED: 'NOT_SUBSCRIBED',
    },
  } as const

  nuid(): string {
    return `mock-${++this._nuidCounter}`
  }

  get user(): string | null {
    return null
  }

  get stats(): { record: RecordStats; rpc: RpcStats; event: EventStats } {
    return {
      rpc: this.rpc.stats,
      event: this.event.stats,
      record: this.record.stats,
    }
  }

  getConnectionState(): ReturnType<DeepstreamClient['getConnectionState']> {
    return 'OPEN'
  }

  isSameOrNewer(a: string, b: string): boolean {
    const splitRev = (s: string): [number, string] => {
      if (!s) {
        return [-1, '']
      }
      const i = s.indexOf('-')
      const v = i === -1 ? s : s.slice(0, i)
      return [v.charAt(0) === 'I' ? Infinity : parseInt(v, 10), i === -1 ? '' : s.slice(i + 1)]
    }
    const [av, ar] = splitRev(a)
    const [bv, br] = splitRev(b)
    return av > bv || (av === bv && ar >= br)
  }

  login(_cb?: unknown, _data?: unknown): this {
    return this
  }

  close(): void {}

  on(evt: string, callback: (...args: unknown[]) => void): this {
    let set = this._listeners.get(evt)
    if (!set) {
      this._listeners.set(evt, (set = new Set()))
    }
    set.add(callback)
    return this
  }

  off(evt: string, callback: (...args: unknown[]) => void): this {
    this._listeners.get(evt)?.delete(callback)
    return this
  }

  cleanup(): void {
    this.record.cleanup()
    this.rpc.cleanup()
    this.event.cleanup()
    this._listeners.clear()
    this._nuidCounter = 0
  }
}

// ---------------------------------------------------------------------------
// RecordHandler
// ---------------------------------------------------------------------------

export class MockRecordHandler<
  Records extends Record<string, unknown> = Record<string, unknown>,
> implements RecordHandler<Records> {
  readonly VOID: 0 = VOID
  readonly CLIENT: 1 = CLIENT
  readonly SERVER: 2 = SERVER
  readonly STALE: 3 = STALE
  readonly PROVIDER: 4 = PROVIDER

  readonly STATE: {
    VOID: 0
    CLIENT: 1
    SERVER: 2
    STALE: 3
    PROVIDER: 4
    [key: string]: number
  } = { VOID: 0, CLIENT: 1, SERVER: 2, STALE: 3, PROVIDER: 4 }

  readonly JSON: {
    EMPTY: Record<string, unknown>
    EMPTY_OBJ: Record<string, unknown>
    EMPTY_ARR: []
  } = {
    EMPTY,
    EMPTY_OBJ: EMPTY,
    EMPTY_ARR: EMPTY_ARR as unknown as [],
  }

  static event = {}
  static record = {}
  static rpc = {}

  private _records: Map<string, MockRecord<unknown>> = new Map()
  private _providers: Array<[pattern: string, callback: (key: string) => unknown]> = []
  private _created = 0

  constructor() {
    // Real: the handler binds these methods so destructured usage works
    // (record-handler.js:125-132).
    this.set = this.set.bind(this) as typeof this.set
    this.get = this.get.bind(this) as typeof this.get
    this.update = this.update.bind(this) as typeof this.update
    this.observe = this.observe.bind(this) as typeof this.observe
    this.observe2 = this.observe2.bind(this) as typeof this.observe2
    this.sync = this.sync.bind(this) as typeof this.sync
    this.provide = this.provide.bind(this) as typeof this.provide
    this.getRecord = this.getRecord.bind(this) as typeof this.getRecord
  }

  get connected() {
    return true
  }

  get stats(): RecordStats {
    let subscriptions = 0
    for (const record of this._records.values()) {
      for (const inner of record.subscriptions.values()) {
        subscriptions += inner.size
      }
      subscriptions += record._observeCount
    }
    return {
      subscriptions,
      records: this._records.size,
      listeners: this._providers.length,
      created: this._created,
      updating: 0,
      destroyed: 0,
      pruning: 0,
      patching: 0,
    }
  }

  // The real provider infrastructure flattens providers that emit
  // observables (a common provider shape is an outer record observe mapping
  // each emission to an inner pipeline); mirror it recursively so provided
  // record data is never an Observable instance.
  private _flatten(value: unknown): Observable<unknown> {
    return isObservableLike(value)
      ? toNativeObservable(value).pipe(rxjs.switchMap((inner) => this._flatten(inner)))
      : rxjs.of(value)
  }

  private _toObservable(value: unknown): Observable<unknown> | null {
    if (isObservableLike(value)) {
      return this._flatten(value)
    }
    if (value != null) {
      return new BehaviorSubject(value)
    }
    return null
  }

  private _findProvider(name: string): Observable<unknown> | null {
    for (let i = this._providers.length - 1; i >= 0; i--) {
      const [pattern, cb] = this._providers[i]
      if (new RegExp(pattern).test(name)) {
        const obs = this._toObservable(cb(name))
        if (obs) {
          return obs
        }
      }
    }
    return null
  }

  private _createRecord(name: string): MockRecord<unknown> {
    const record = new MockRecord<unknown>(name)
    this._records.set(name, record)
    this._created++
    const provider = this._findProvider(name)
    if (provider) {
      record.setProvider(provider)
    } else {
      // Simulate the server's empty-record response: SERVER state with a
      // numeric version (real versions match /^\d+-/, record-handler.js:420).
      record.version = '0-mock'
      record.setState(SERVER, EMPTY as unknown)
    }
    return record
  }

  // Mirrors the sequential argument parser of the real _observe
  // (record-handler.js:549-619): [path], [state], [options], where path may be
  // a string, an array or a function selector, and options may override both.
  private _parseObserveArgs(
    defaults: { state: number; dataOnly: boolean },
    args: unknown[],
  ): {
    path: string | string[] | ((data: unknown) => unknown) | undefined
    state: number
    timeout: number
    dataOnly: boolean
    signal: AbortSignal | null
  } {
    let path: string | string[] | ((data: unknown) => unknown) | undefined
    let state: unknown = defaults.state
    let dataOnly = defaults.dataOnly
    let timeout = 2 * 60e3
    let signal: AbortSignal | null = null

    let idx = 0

    if (
      idx < args.length &&
      (args[idx] == null ||
        typeof args[idx] === 'string' ||
        Array.isArray(args[idx]) ||
        typeof args[idx] === 'function')
    ) {
      path = args[idx++] as typeof path
    }

    if (idx < args.length && (args[idx] == null || typeof args[idx] === 'number')) {
      state = args[idx++]
    }

    if (idx < args.length && (args[idx] == null || typeof args[idx] === 'object')) {
      const options = (args[idx++] || {}) as ObserveOptionsWithPath<string>
      if (options.signal !== undefined) {
        signal = options.signal
      }
      if (options.timeout !== undefined) {
        timeout = options.timeout
      }
      if (options.path !== undefined) {
        path = options.path
      }
      if (options.state !== undefined) {
        state = options.state
      }
      if (options.dataOnly !== undefined) {
        dataOnly = options.dataOnly
      }
    }

    if (typeof state === 'string') {
      state = this.STATE[state.toUpperCase()]
    }
    if (!Number.isInteger(state) || (state as number) < 0) {
      throw new Error(`invalid argument "state": ${String(state)}`)
    }
    if (!Number.isInteger(timeout) || timeout < 0) {
      throw new Error(`invalid argument "timeout": ${timeout}`)
    }

    return { path, state: state as number, timeout, dataOnly, signal }
  }

  private _observeImpl(
    defaults: { state: number; dataOnly: boolean },
    name: string,
    args: unknown[],
  ): Observable<unknown> {
    const { path, state, timeout, dataOnly, signal } = this._parseObserveArgs(defaults, args)
    const select = (data: unknown) =>
      typeof path === 'function' ? path(data) : path ? jsonPath.get(data, path) : data

    return new Observable((observer) => {
      if (signal?.aborted) {
        // Real: aborted signals error the subscriber immediately
        // (record-handler.js:622-624).
        observer.error(new AbortError())
        return
      }

      // Real: the record is acquired inside the Observable subscribe function
      // (record-handler.js:681) — a cold observable must not create records.
      const r = this.getRecord(name) as unknown as MockRecord<unknown>
      r._observeCount++

      let source: Observable<unknown> = r.subject.pipe(
        rxjs.filter((s) => s.state >= state),
        rxjs.map(({ state: s, data }) =>
          dataOnly
            ? select(data)
            : { name: r.name, version: r.version, state: s, data: select(data) },
        ),
      )

      if (dataOnly) {
        // Real: dataOnly subscriptions only notify when the selected data
        // actually changed (record-handler.js:58-62).
        source = source.pipe(rxjs.distinctUntilChanged())
      }

      if (timeout > 0) {
        // Real: subscriptions error with ETIMEDOUT when the requested state is
        // not reached in time (record-handler.js:73-98, 690-692). The timer
        // only guards the first qualifying emission, like the real client.
        source = source.pipe(
          rxjs.timeout({
            first: timeout,
            with: () =>
              rxjs.throwError(() =>
                timeoutError(
                  `timeout state: ${name} [${RECORD_STATE_NAME[r.state]}<${RECORD_STATE_NAME[state]}]`,
                  {
                    timeout,
                    expected: RECORD_STATE_NAME[state],
                    current: RECORD_STATE_NAME[r.state],
                    name,
                  },
                ),
              ),
          }),
        )
      }

      if (signal) {
        source = rxjs.merge(
          source,
          rxjs
            .fromEvent(signal, 'abort')
            .pipe(rxjs.mergeMap(() => rxjs.throwError(() => new AbortError()))),
        )
      }

      const sub = source.subscribe(observer)
      return () => {
        r._observeCount--
        r.unref()
        sub.unsubscribe()
      }
    })
  }

  // --------------- getRecord ---------------

  getRecord<Name extends string, Data = Lookup<Records, Name>>(name: Name): DsRecord<Data> {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('invalid argument: name')
    }
    const r = this._records.get(name) ?? this._createRecord(name)
    // Real: getRecord returns record.ref() (record-handler.js:235).
    return r.ref() as DsRecord<Data>
  }

  // --------------- put ---------------

  put(name: string, version: string, data: Record<string, unknown> | null): void {
    // Same validation as the real put (record-handler.js:415-430).
    if (typeof name !== 'string' || name.startsWith('_')) {
      throw new Error('invalid argument: name')
    }
    if (typeof version !== 'string' || !/^\d+-/.test(version)) {
      throw new Error('invalid argument: version')
    }
    if (typeof data !== 'object' && data != null) {
      throw new Error('invalid argument: data')
    }
    const record = this._records.get(name) ?? this._createRecord(name)
    record.version = version
    record.setState(SERVER, (data ?? EMPTY) as unknown)
  }

  // --------------- getAsync ---------------

  getAsync<Name extends string>(
    name: Name,
    options: ObserveOptions,
  ):
    | { value: Lookup<Records, Name>; async: false }
    | { value: Promise<Lookup<Records, Name>>; async: true }
  getAsync<Name extends string, Path extends string | string[]>(
    name: Name,
    path: Path,
    options?: ObserveOptions,
  ):
    | { value: Get<Lookup<Records, Name>, Path>; async: false }
    | { value: Promise<Get<Lookup<Records, Name>, Path>>; async: true }
  getAsync<Name extends string>(
    name: Name,
    state?: number,
  ):
    | { value: Lookup<Records, Name>; async: false }
    | { value: Promise<Lookup<Records, Name>>; async: true }
  getAsync(
    name: string,
    ...args: unknown[]
  ): { value: unknown; async: false } | { value: Promise<unknown>; async: true } {
    // Mirrors the real getAsync (record-handler.js:486-526): default state is
    // CLIENT, and passing an options object always takes the async path.
    const get = this.get as (n: string, ...a: unknown[]) => Promise<unknown>

    let path: unknown
    let state: unknown = CLIENT
    let idx = 0

    if (
      idx < args.length &&
      (args[idx] == null ||
        typeof args[idx] === 'string' ||
        Array.isArray(args[idx]) ||
        typeof args[idx] === 'function')
    ) {
      path = args[idx++]
    }

    if (idx < args.length && (args[idx] == null || typeof args[idx] === 'number')) {
      state = args[idx++]
    }

    if (idx < args.length && (args[idx] == null || typeof args[idx] === 'object')) {
      return { value: get(name, ...args), async: true }
    }

    if (typeof state === 'string') {
      state = this.STATE[state.toUpperCase()]
    }
    if (!Number.isInteger(state) || (state as number) < 0) {
      throw new Error('invalid argument: state')
    }

    const rec = this.getRecord(name) as unknown as MockRecord<unknown>
    try {
      return rec.state >= (state as number)
        ? { value: (rec.get as (p?: unknown) => unknown)(path), async: false }
        : { value: get(name, ...args), async: true }
    } finally {
      rec.unref()
    }
  }

  // --------------- get ---------------

  get<Name extends string>(name: Name, options: ObserveOptions): Promise<Lookup<Records, Name>>
  get<Name extends string, Path extends string | string[]>(
    name: Name,
    options: ObserveOptionsWithPath<Path>,
  ): Promise<Get<Lookup<Records, Name>, Path>>
  get<Name extends string>(
    name: Name,
    state?: number,
    options?: ObserveOptions,
  ): Promise<Lookup<Records, Name>>
  get<Name extends string, Path extends string | string[]>(
    name: Name,
    state?: number,
    options?: ObserveOptionsWithPath<Path>,
  ): Promise<Get<Lookup<Records, Name>, Path>>
  get<Name extends string, Path extends string | string[]>(
    name: Name,
    path: Path,
    options?: ObserveOptionsWithPath<Path>,
  ): Promise<Get<Lookup<Records, Name>, Path>>
  get<Name extends string, Path extends string | string[]>(
    name: Name,
    path: Path,
    state?: number,
    options?: ObserveOptionsWithPath<Path>,
  ): Promise<Get<Lookup<Records, Name>, Path>>
  get(name: string, ...args: unknown[]): Promise<unknown> {
    // Real GET_DEFAULTS: dataOnly, default state CLIENT (record-handler.js:25-29).
    return firstValueFrom(this._observeImpl({ state: CLIENT, dataOnly: true }, name, args))
  }

  // --------------- get2 ---------------

  get2<Name extends string>(
    name: Name,
    options: ObserveOptions,
  ): Promise<{ name: string; version: string; state: number; data: Lookup<Records, Name> }>
  get2<Name extends string, Path extends string | string[]>(
    name: Name,
    options: ObserveOptionsWithPath<Path>,
  ): Promise<{
    name: string
    version: string
    state: number
    data: Get<Lookup<Records, Name>, Path>
  }>
  get2<Name extends string>(
    name: Name,
    state?: number,
    options?: ObserveOptions,
  ): Promise<{ name: string; version: string; state: number; data: Lookup<Records, Name> }>
  get2<Name extends string, Path extends string | string[]>(
    name: Name,
    state?: number,
    options?: ObserveOptionsWithPath<Path>,
  ): Promise<{
    name: string
    version: string
    state: number
    data: Get<Lookup<Records, Name>, Path>
  }>
  get2<Name extends string, Path extends string | string[]>(
    name: Name,
    path: Path,
    options?: ObserveOptionsWithPath<Path>,
  ): Promise<{
    name: string
    version: string
    state: number
    data: Get<Lookup<Records, Name>, Path>
  }>
  get2<Name extends string, Path extends string | string[]>(
    name: Name,
    path: Path,
    state?: number,
    options?: ObserveOptionsWithPath<Path>,
  ): Promise<{
    name: string
    version: string
    state: number
    data: Get<Lookup<Records, Name>, Path>
  }>
  get2(
    name: string,
    ...args: unknown[]
  ): Promise<{ name: string; version: string; state: number; data: unknown }> {
    // Real GET2_DEFAULTS: metadata, default state CLIENT (record-handler.js:30-33).
    return firstValueFrom(
      this._observeImpl({ state: CLIENT, dataOnly: false }, name, args),
    ) as Promise<{
      name: string
      version: string
      state: number
      data: unknown
    }>
  }

  // --------------- set ---------------

  set<Name extends string>(name: Name, data: Lookup<Records, Name>): void
  set<Name extends string, Path extends string | string[]>(
    name: Name,
    path: Path,
    data: Get<Lookup<Records, Name>, Path>,
  ): void
  set(name: string, ...args: unknown[]): void {
    // Real: acquire, set, unref (record-handler.js:406-413).
    const record = this.getRecord(name)
    try {
      ;(record.set as (...a: unknown[]) => void)(...args)
    } finally {
      record.unref()
    }
  }

  // --------------- update ---------------

  update<Name extends string>(
    name: Name,
    updater: (data: Lookup<Records, Name>, version: string) => Lookup<Records, Name>,
    options?: UpdateOptions,
  ): Promise<void>
  update<Name extends string, Path extends string | string[]>(
    name: Name,
    path: Path,
    updater: (
      data: Get<Lookup<Records, Name>, Path>,
      version: string,
    ) => Get<Lookup<Records, Name>, Path>,
    options?: UpdateOptions,
  ): Promise<void>
  update(name: string, ...args: unknown[]): Promise<void> {
    // Real: sync throws become rejections (record-handler.js:450-461).
    try {
      const record = this.getRecord(name)
      try {
        return (record.update as (...a: unknown[]) => Promise<void>)(...args)
      } finally {
        record.unref()
      }
    } catch (err) {
      return Promise.reject(err)
    }
  }

  // --------------- observe ---------------

  observe<Name extends string>(
    name: Name,
    options: ObserveOptions,
  ): Observable<Lookup<Records, Name>>
  observe<Name extends string, Path extends string | string[]>(
    name: Name,
    options: ObserveOptionsWithPath<Path>,
  ): Observable<Get<Lookup<Records, Name>, Path>>
  observe<Name extends string>(
    name: Name,
    state?: number,
    options?: ObserveOptions,
  ): Observable<Lookup<Records, Name>>
  observe<Name extends string, Path extends string | string[]>(
    name: Name,
    state?: number,
    options?: ObserveOptionsWithPath<Path>,
  ): Observable<Get<Lookup<Records, Name>, Path>>
  observe<Name extends string, Path extends string | string[]>(
    name: Name,
    path: Path,
    options?: ObserveOptionsWithPath<Path>,
  ): Observable<Get<Lookup<Records, Name>, Path>>
  observe<Name extends string, Path extends string | string[]>(
    name: Name,
    path: Path,
    state?: number,
    options?: ObserveOptionsWithPath<Path>,
  ): Observable<Get<Lookup<Records, Name>, Path>>
  observe(name: string, ...args: unknown[]): Observable<unknown> {
    // Real OBSERVE_DEFAULTS: dataOnly, default state SERVER (record-handler.js:17-21).
    return this._observeImpl({ state: SERVER, dataOnly: true }, name, args)
  }

  // --------------- observe2 ---------------

  observe2<Name extends string>(
    name: Name,
    options: ObserveOptions,
  ): Observable<{ name: string; version: string; state: number; data: Lookup<Records, Name> }>
  observe2<Name extends string, Path extends string | string[]>(
    name: Name,
    options: ObserveOptionsWithPath<Path>,
  ): Observable<{
    name: string
    version: string
    state: number
    data: Get<Lookup<Records, Name>, Path>
  }>
  observe2<Name extends string>(
    name: Name,
    state?: number,
    options?: ObserveOptions,
  ): Observable<{ name: string; version: string; state: number; data: Lookup<Records, Name> }>
  observe2<Name extends string, Path extends string | string[]>(
    name: Name,
    state?: number,
    options?: ObserveOptionsWithPath<Path>,
  ): Observable<{
    name: string
    version: string
    state: number
    data: Get<Lookup<Records, Name>, Path>
  }>
  observe2<Name extends string, Path extends string | string[]>(
    name: Name,
    path: Path,
    options?: ObserveOptionsWithPath<Path>,
  ): Observable<{
    name: string
    version: string
    state: number
    data: Get<Lookup<Records, Name>, Path>
  }>
  observe2<Name extends string, Path extends string | string[]>(
    name: Name,
    path: Path,
    state?: number,
    options?: ObserveOptionsWithPath<Path>,
  ): Observable<{
    name: string
    version: string
    state: number
    data: Get<Lookup<Records, Name>, Path>
  }>
  observe2(
    name: string,
    ...args: unknown[]
  ): Observable<{ name: string; version: string; state: number; data: unknown }> {
    // Real OBSERVE2_DEFAULTS: metadata, default state CLIENT (record-handler.js:22-24).
    return this._observeImpl({ state: CLIENT, dataOnly: false }, name, args) as Observable<{
      name: string
      version: string
      state: number
      data: unknown
    }>
  }

  // --------------- provide ---------------

  provide(
    pattern: string,
    cb: (key: string) => unknown,
    _optionsOrRecursive?: ProvideOptions | boolean,
  ): Disposer {
    // Same validation as the real provide (record-handler.js:238-254).
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error('invalid argument pattern')
    }
    if (typeof cb !== 'function') {
      throw new Error('invalid argument callback')
    }
    if (this._providers.some(([p]) => p === pattern)) {
      throw new Error(`pattern already provided: ${pattern}`)
    }

    this._providers.push([pattern, cb])

    for (const record of this._records.values()) {
      if (new RegExp(pattern).test(record.name)) {
        const obs = this._toObservable(cb(record.name))
        if (obs) {
          record.setProvider(obs)
        }
      }
    }

    return makeDisposer(() => {
      const index = this._providers.findIndex((p) => p[0] === pattern && p[1] === cb)
      if (index !== -1) {
        this._providers.splice(index, 1)
      }
      for (const record of this._records.values()) {
        if (new RegExp(pattern).test(record.name)) {
          record.setProvider(this._findProvider(record.name))
        }
      }
    })
  }

  async sync() {}

  cleanup(): void {
    for (const record of this._records.values()) {
      record.cleanup()
    }
    this._providers.splice(0, this._providers.length)
    this._records.clear()
    this._created = 0
  }
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

export class MockRecord<Data = unknown> implements DsRecord<Data> {
  public name: string
  public refs = 0
  // Real records start with an empty version (record.js:18); records that
  // simulate a server response get '0-mock', providers set 'INF-<hash>'.
  public version = ''

  public readonly subject = new BehaviorSubject<{
    state: number
    data: Data
  }>({ state: VOID, data: EMPTY as unknown as Data })

  public provider: Observable<unknown> | null = null
  // callback → opaque → live subscription; unsubscribe matches the
  // (callback, opaque) pair like the real client (record.js:116-141).
  public subscriptions = new Map<
    (record: DsRecord<Data>, opaque: unknown) => void,
    Map<unknown, Subscription>
  >()
  public _observeCount = 0
  private _providerSubscription: Subscription | null = null

  constructor(name: string) {
    this.name = name
  }

  setProvider(provider: Observable<unknown> | null): void {
    this._providerSubscription?.unsubscribe()
    this._providerSubscription = null
    this.provider = provider

    if (!provider) {
      this._onProviderGone()
      return
    }

    let withdrawn = false
    const subscription = provider.subscribe((value) => {
      if (withdrawn) {
        return
      }
      if (value == null) {
        // Real: a provider emitting null withdraws — the listener rejects the
        // subscription (legacy-listener.js:141-143), the server reports
        // hasProvider=false and the record goes STALE keeping its data
        // (record.js:550-567).
        withdrawn = true
        this.provider = null
        this._providerSubscription?.unsubscribe()
        this._providerSubscription = null
        this._onProviderGone()
        return
      }
      // Real: providers stringify the payload and version updates as
      // `INF-<hash>`, skipping identical payloads (legacy-listener.js:149-181).
      const body = JSON.stringify(value)
      const version = `INF-${hashString(body)}`
      if (version === this.version) {
        return
      }
      this.version = version
      this.subject.next({
        state: PROVIDER,
        data: jsonPath.set(this.data, null, JSON.parse(body) as unknown, true) as Data,
      })
    })
    if (withdrawn) {
      subscription.unsubscribe()
    } else {
      this._providerSubscription = subscription
    }
  }

  private _onProviderGone(): void {
    // Provider removed: preserve data; I-versioned (provider) data goes STALE,
    // numeric versions go back to SERVER (record.js:550-567).
    const state = this.version.charAt(0) === 'I' ? STALE : SERVER
    if (this.state !== state) {
      this.subject.next({ state, data: this.data })
    }
  }

  cleanup(): void {
    this._providerSubscription?.unsubscribe()
    this._providerSubscription = null
  }

  [Symbol.dispose](): void {
    // Real: dispose is a plain unref (record.js:89-91).
    this.unref()
  }

  get data(): Data {
    return this.subject.getValue().data
  }

  get state(): number {
    return this.subject.getValue().state
  }

  ref(): DsRecord<Data> {
    this.refs++
    return this as unknown as DsRecord<Data>
  }

  unref(): DsRecord<Data> {
    this.refs--
    return this as unknown as DsRecord<Data>
  }

  setState(state: number, data?: Data): void {
    this.subject.next({ state, data: data !== undefined ? data : this.data })
  }

  subscribe(
    callback: (record: DsRecord<Data>, opaque: unknown) => void,
    opaque: unknown = null,
  ): DsRecord<Data> {
    let inner = this.subscriptions.get(callback)
    if (!inner) {
      this.subscriptions.set(callback, (inner = new Map()))
    }
    inner.get(opaque)?.unsubscribe()
    // Real: subscribe only registers; callbacks fire on subsequent updates
    // (record.js:98-108) — skip the BehaviorSubject's current value.
    inner.set(
      opaque,
      this.subject
        .pipe(rxjs.skip(1))
        .subscribe(() => callback(this as unknown as DsRecord<Data>, opaque)),
    )
    return this as unknown as DsRecord<Data>
  }

  unsubscribe(
    callback: (record: DsRecord<Data>, opaque: unknown) => void,
    opaque: unknown = null,
  ): DsRecord<Data> {
    const inner = this.subscriptions.get(callback)
    const sub = inner?.get(opaque)
    if (inner && sub) {
      sub.unsubscribe()
      inner.delete(opaque)
      if (inner.size === 0) {
        this.subscriptions.delete(callback)
      }
    }
    return this as unknown as DsRecord<Data>
  }

  get<P extends string | string[]>(path: P): Get<Data, P>
  get<R>(fn: (data: Data) => R): R
  get(): Data
  get(path?: unknown): unknown {
    // Same argument handling as the real get (record.js:184-194).
    if (!path) {
      return this.data
    } else if (typeof path === 'string' || Array.isArray(path)) {
      return jsonPath.get(this.data, path)
    } else if (typeof path === 'function') {
      return (path as (data: Data) => unknown)(this.data)
    } else {
      throw new Error('invalid argument: path')
    }
  }

  set(data: Data): void
  set<P extends string>(path: P, data: Get<Data, P>): void
  set(pathOrData: unknown, dataOrNil?: unknown): void {
    // Real: I-versioned (provider) records and '_'-names cannot be set —
    // USER_ERROR 'cannot set', which throws without an 'error' listener
    // (record.js:202-205 + client.js:100-109).
    if (this.version.charAt(0) === 'I' || this.name.startsWith('_')) {
      throw Object.assign(new Error('cannot set'), { event: 'USER_ERROR' })
    }

    // The real client disambiguates the overloads on argument count, not on
    // the value: set(path, undefined) clears the path, it must not replace
    // the record data with the path string.
    const path = arguments.length === 1 ? undefined : pathOrData
    const data = arguments.length === 1 ? pathOrData : dataOrNil

    // Same validation as the real set (record.js:210-222).
    if (path === undefined && !isPlainObject(data)) {
      throw new Error('invalid argument: data')
    }
    if (path === undefined && Object.keys(data as object).some((prop) => prop.startsWith('_'))) {
      throw new Error('invalid argument: data')
    }
    if (path !== undefined && !isValidPath(path)) {
      throw new Error('invalid argument: path')
    }

    // Real: set → _update(jsonPath.set(...)) which no-ops when structural
    // sharing returns the same reference (record.js:436-443) — no version
    // bump, no emission. jsonPath also JSON-clones incoming values, so caller
    // mutations cannot leak into record data.
    const nextData = jsonPath.set(
      this.data,
      path as string | string[] | undefined,
      data,
      false,
    ) as Data
    if (nextData === this.data) {
      return
    }

    this.version = `${(this.version ? parseInt(this.version, 10) : 0) + 1}-mock`
    this.subject.next({ state: SERVER, data: nextData })
  }

  // Real client passes version as second argument to the updater
  update(updater: (data: Data, version: string) => Data, options?: UpdateOptions): Promise<void>
  update<P extends string>(
    path: P,
    updater: (data: Get<Data, P>, version: string) => Get<Data, P>,
    options?: UpdateOptions,
  ): Promise<void>
  async update(
    pathOrUpdater: string | string[] | ((...args: never[]) => unknown),
    updaterOrOptions?: UpdateOptions | ((...args: never[]) => unknown),
    optionsOrNil?: UpdateOptions,
  ): Promise<void> {
    // Real: updates of I-versioned (provider) records raise UPDATE_ERROR
    // 'cannot update' and do not apply (record.js:341-348).
    if (this.version.charAt(0) === 'I') {
      throw Object.assign(new Error('cannot update'), { event: 'UPDATE_ERROR' })
    }

    const path = typeof pathOrUpdater === 'function' ? undefined : pathOrUpdater
    const updater =
      typeof pathOrUpdater === 'function'
        ? pathOrUpdater
        : typeof updaterOrOptions === 'function'
          ? updaterOrOptions
          : undefined

    if (typeof updater !== 'function') {
      throw new Error('invalid argument: updater')
    }
    if (path !== undefined && !isValidPath(path)) {
      throw new Error('invalid argument: path')
    }

    const options: UpdateOptions | undefined =
      optionsOrNil ?? (typeof updaterOrOptions !== 'function' ? updaterOrOptions : undefined)

    if (options?.signal?.aborted) {
      throw (options.signal.reason as Error) ?? new AbortError()
    }

    await this.when(SERVER, options)

    const prev = path ? jsonPath.get(this.data, path) : (this.data as unknown)
    const next = (updater as (data: unknown, version: string) => unknown)(prev, this.version)

    // Real: only write when something changed, and never write a nullish
    // whole-record result (record.js:375).
    if (prev !== next && (path || next != null)) {
      if (path) {
        ;(this.set as (p: unknown, d: unknown) => void)(path, next)
      } else {
        this.set(next as Data)
      }
    }
  }

  when(): Promise<DsRecord<Data>>
  when(options: WhenOptions): Promise<DsRecord<Data>>
  when(state: number, options?: WhenOptions): Promise<DsRecord<Data>>
  when(stateOrOptions?: number | WhenOptions, optionsOrNil?: WhenOptions): Promise<DsRecord<Data>> {
    // Same argument handling and defaults as the real when (record.js:243-262):
    // default state SERVER, default timeout 2 minutes, signal support.
    let options: WhenOptions | undefined
    let state: number
    if (stateOrOptions != null && typeof stateOrOptions === 'object') {
      options = stateOrOptions
      state = options.state ?? SERVER
    } else {
      state = stateOrOptions ?? SERVER
      options = optionsOrNil
    }

    const signal = options?.signal
    const timeout = options?.timeout ?? 2 * 60e3

    if (signal?.aborted) {
      return Promise.reject((signal.reason as Error) ?? new AbortError())
    }
    if (!Number.isFinite(state) || state < 0) {
      return Promise.reject(new Error('invalid argument: state'))
    }

    let source: Observable<unknown> = this.subject.pipe(rxjs.filter((s) => s.state >= state))

    if (timeout > 0) {
      // Real: rejects with an ETIMEDOUT-coded error (record.js:315-325).
      source = source.pipe(
        rxjs.timeout({
          first: timeout,
          with: () =>
            rxjs.throwError(() =>
              timeoutError(
                `timeout  ${this.name} [${RECORD_STATE_NAME[this.state]}<${RECORD_STATE_NAME[state]}]`,
                {},
              ),
            ),
        }),
      )
    }

    if (signal) {
      source = rxjs.merge(
        source,
        rxjs
          .fromEvent(signal, 'abort')
          .pipe(
            rxjs.mergeMap(() =>
              rxjs.throwError(() => (signal.reason as Error) ?? new AbortError()),
            ),
          ),
      )
    }

    return firstValueFrom(source).then(() => this as unknown as DsRecord<Data>)
  }
}

// ---------------------------------------------------------------------------
// JSON record name utilities
// ---------------------------------------------------------------------------

export function parseJsonRecordName(
  name: string,
): { json: Record<string, unknown>; suffix: string } | null {
  const match = /^(\{.*?\})(:.*)$/.exec(name)
  if (!match) {
    return null
  }
  try {
    return { json: JSON.parse(match[1]) as Record<string, unknown>, suffix: match[2] }
  } catch {
    return null
  }
}

export function jsonProvider<T = unknown>(
  suffix: string,
  matcher: (json: Record<string, unknown>) => T | null,
): [pattern: string, callback: (name: string) => T | null] {
  const pattern = `^.*${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
  return [
    pattern,
    (name: string) => {
      const parsed = parseJsonRecordName(name)
      if (!parsed) {
        return null
      }
      return matcher(parsed.json)
    },
  ]
}
