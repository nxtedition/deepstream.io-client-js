/**
 * In-memory mock of the deepstream client.
 *
 * Known differences from the real client:
 *  - getConnectionState() always returns 'OPEN'. No network, auth, or reconnection logic.
 *  - event.provide() throws — not implemented
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

// ---------------------------------------------------------------------------
// Disposer
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
    this._reject(new Error('RPC rejected'))
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

  get connected(): boolean {
    return true
  }

  get stats(): RpcStats {
    return { listeners: this._providers.size, rpcs: this._pendingRpcs }
  }

  provide<Name extends string & keyof Methods>(
    name: Name,
    callback: (data: Methods[Name][0], response: MockRpcResponse<Methods[Name][1]>) => unknown,
  ): () => void
  provide(
    name: string,
    callback: (data: unknown, response: MockRpcResponse<unknown>) => unknown,
  ): () => void
  provide(
    name: string,
    callback: (data: unknown, response: MockRpcResponse<unknown>) => unknown,
  ): () => void {
    this._providers.set(name, callback)
    return () => {
      if (this._providers.get(name) === callback) {
        this._providers.delete(name)
      }
    }
  }

  unprovide<Name extends string & keyof Methods>(name: Name): void
  unprovide(name: string): void
  unprovide(name: string): void {
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
    const provider = this._providers.get(name)
    if (!provider) {
      const err = Object.assign(new Error('NO_RPC_PROVIDER'), {
        rpcName: name,
        rpcData: data,
      })
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
      if (callback) {
        callback(err, val)
      } else if (err) {
        reject_!(err)
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
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export class MockEventHandler implements EventHandler {
  private _subscriptions = new Map<string, Set<(data: unknown) => void>>()
  private _onceWrappers = new Map<(data: unknown) => void, (data: unknown) => void>()
  private _emittedCount = 0

  get connected(): boolean {
    return true
  }

  get stats(): EventStats {
    let listeners = 0
    for (const set of this._subscriptions.values()) {
      listeners += set.size
    }
    return {
      emitted: this._emittedCount,
      listeners,
      events: this._subscriptions.size,
    }
  }

  emit(name: string, data?: unknown): void {
    this._emittedCount++
    for (const cb of this._subscriptions.get(name) ?? []) {
      cb(data)
    }
  }

  subscribe(name: string, callback: (data: unknown) => void): void {
    let subs = this._subscriptions.get(name)
    if (!subs) {
      this._subscriptions.set(name, (subs = new Set()))
    }
    subs.add(callback)
  }

  unsubscribe(name: string, callback?: (data: unknown) => void): void {
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
    const wrapper = (data: unknown) => {
      this.off(name, callback)
      callback(data)
    }
    this._onceWrappers.set(callback, wrapper)
    this.subscribe(name, wrapper)
    return this
  }

  off(name: string, callback: (data: unknown) => void): this {
    const wrapper = this._onceWrappers.get(callback)
    if (wrapper) {
      this._onceWrappers.delete(callback)
      this.unsubscribe(name, wrapper)
    } else {
      this.unsubscribe(name, callback)
    }
    return this
  }

  observe<Data = unknown>(name: string): Observable<Data> {
    return new Observable<Data>((observer) => {
      const cb = (data: unknown) => observer.next(data as Data)
      this.subscribe(name, cb)
      return () => this.unsubscribe(name, cb)
    })
  }

  provide(_pattern: string, _callback: (name: string) => void, _options: unknown): () => void {
    throw new Error('MockEventHandler.provide() is not implemented')
  }

  cleanup(): void {
    this._subscriptions.clear()
    this._onceWrappers.clear()
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
    record.setState(state, data)
  }

  public cleanup(): void {
    this.client.cleanup()
  }

  public getRecordSubscriptions(name: string) {
    const record = this.client.record.getRecord(name) as unknown as MockRecord<unknown>
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

  get connected() {
    return true
  }

  get stats(): RecordStats {
    let subscriptions = 0
    for (const record of this._records.values()) {
      subscriptions += record.subscriptions.size + record._observeCount
    }
    return {
      subscriptions,
      records: this._records.size,
      listeners: this._providers.length,
      updating: 0,
      created: 0,
      destroyed: 0,
      pruning: 0,
      patching: 0,
    }
  }

  private _toObservable(value: unknown): Observable<unknown> | null {
    if (value instanceof Observable) {
      return value
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
    const provider = this._findProvider(name)
    if (provider) {
      record.setProvider(provider)
    } else {
      record.setState(SERVER, EMPTY as unknown) // simulate server's empty-record response
    }
    return record
  }

  private _parseObserveArgs(
    pathOrStateOrOptions?: string | number | ObserveOptions,
    maybeStateOrOptions?: number | ObserveOptions,
  ): { path: string | undefined; state: number } {
    if (typeof pathOrStateOrOptions === 'string') {
      const state =
        typeof maybeStateOrOptions === 'number'
          ? maybeStateOrOptions
          : (maybeStateOrOptions?.state ?? SERVER)
      return { path: pathOrStateOrOptions, state }
    }
    if (typeof pathOrStateOrOptions === 'number') {
      return { path: undefined, state: pathOrStateOrOptions }
    }
    if (pathOrStateOrOptions != null && typeof pathOrStateOrOptions === 'object') {
      const path = (pathOrStateOrOptions as ObserveOptionsWithPath<string>).path
      return { path, state: pathOrStateOrOptions.state ?? SERVER }
    }
    return { path: undefined, state: SERVER }
  }

  // --------------- getRecord ---------------

  getRecord<Name extends string, Data = Lookup<Records, Name>>(name: Name): DsRecord<Data> {
    const r = this._records.get(name) ?? this._createRecord(name)
    return r as DsRecord<Data>
  }

  // --------------- put ---------------

  put(name: string, version: string, data: Record<string, unknown> | null): void {
    const record = this._records.get(name) ?? this._createRecord(name)
    ;(record as unknown as MockRecord<unknown>).version = version
    ;(record as unknown as MockRecord<unknown>).setState(SERVER, data ?? EMPTY)
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
    pathOrState?: string | string[] | number | ObserveOptions,
    options?: ObserveOptions,
  ): { value: unknown; async: false } | { value: Promise<unknown>; async: true } {
    const record = this.getRecord(name) as unknown as MockRecord<unknown>
    const state =
      typeof pathOrState === 'number'
        ? pathOrState
        : (options?.state ?? (pathOrState as ObserveOptions)?.state ?? SERVER)
    const path =
      typeof pathOrState === 'string' || Array.isArray(pathOrState) ? pathOrState : undefined
    const getValue = () => (path ? jsonPath.get(record.data, path) : record.data)
    if (record.state >= state) {
      return { value: getValue(), async: false }
    }
    return {
      async: true,
      value: record.when(state).then(getValue),
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
  get(
    name: string,
    pathOrStateOrOptions?: string | number | ObserveOptions,
    maybeStateOrOptions?: number | ObserveOptions,
  ): Promise<unknown> {
    return firstValueFrom(
      (this.observe as (n: string, a?: unknown, b?: unknown) => Observable<unknown>)(
        name,
        pathOrStateOrOptions,
        maybeStateOrOptions,
      ),
    )
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
    pathOrState?: string | number | ObserveOptions,
    maybeState?: number | ObserveOptions,
  ): Promise<{ name: string; version: string; state: number; data: unknown }> {
    return firstValueFrom(
      (
        this.observe2 as (
          n: string,
          a?: unknown,
          b?: unknown,
        ) => Observable<{
          name: string
          version: string
          state: number
          data: unknown
        }>
      )(name, pathOrState, maybeState),
    )
  }

  // --------------- set ---------------

  set<Name extends string>(name: Name, data: Lookup<Records, Name>): void
  set<Name extends string, Path extends string | string[]>(
    name: Name,
    path: Path,
    data: Get<Lookup<Records, Name>, Path>,
  ): void
  set(name: string, ...args: unknown[]): void {
    ;(this.getRecord(name).set as (...a: unknown[]) => void)(...args)
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
    return (this.getRecord(name).update as (...a: unknown[]) => Promise<void>)(...args)
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
  observe(
    name: string,
    pathOrStateOrOptions?: string | number | ObserveOptions,
    maybeStateOrOptions?: number | ObserveOptions,
  ): Observable<unknown> {
    return (
      this.observe2 as (
        n: string,
        a?: unknown,
        b?: unknown,
      ) => Observable<{ name: string; version: string; state: number; data: unknown }>
    )(name, pathOrStateOrOptions, maybeStateOrOptions).pipe(rxjs.map(({ data }) => data))
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
    pathOrStateOrOptions?: string | number | ObserveOptions,
    maybeStateOrOptions?: number | ObserveOptions,
  ): Observable<{ name: string; version: string; state: number; data: unknown }> {
    const { path, state } = this._parseObserveArgs(pathOrStateOrOptions, maybeStateOrOptions)
    const r = this.getRecord(name) as unknown as MockRecord<unknown>
    const source = r.subject.pipe(
      rxjs.filter((s) => s.state >= state),
      rxjs.map(({ state: s, data }) => ({
        name: r.name,
        version: r.version,
        state: s,
        data: path ? jsonPath.get(data, path) : data,
      })),
    )
    return new Observable((observer) => {
      r._observeCount++
      const sub = source.subscribe(observer)
      return () => {
        r._observeCount--
        sub.unsubscribe()
      }
    })
  }

  // --------------- provide ---------------

  provide(
    pattern: string,
    cb: (key: string) => unknown,
    _optionsOrRecursive?: ProvideOptions | boolean,
  ): Disposer {
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
  }
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

export class MockRecord<Data = unknown> implements DsRecord<Data> {
  public name: string
  public refs = 0
  public version = '0'

  public readonly subject = new BehaviorSubject<{
    state: number
    data: Data
  }>({ state: VOID, data: EMPTY as unknown as Data })

  public provider: Observable<unknown> | null = null
  public subscriptions = new Map<(record: DsRecord<Data>, opaque: unknown) => void, Subscription>()
  public _observeCount = 0
  private _providerSubscription: Subscription | null = null
  private _fromProvider = false

  constructor(name: string) {
    this.name = name
  }

  setProvider(provider: Observable<unknown> | null): void {
    this._providerSubscription?.unsubscribe()
    this._providerSubscription = null
    this.provider = provider
    if (provider) {
      this._providerSubscription = provider.subscribe((data) => {
        this._fromProvider = true
        this.subject.next({ data: data as Data, state: PROVIDER })
      })
    } else {
      // Provider removed: preserve data, go STALE if data came from a provider, SERVER otherwise.
      // Matches real client: version with 'I' prefix → STALE, numeric version → SERVER.
      const newState = this._fromProvider ? STALE : SERVER
      this.subject.next({ state: newState, data: this.data })
    }
  }

  cleanup(): void {
    this._providerSubscription?.unsubscribe()
    this._providerSubscription = null
  }

  [Symbol.dispose](): void {
    this.cleanup()
  }

  get data(): Data {
    return this.subject.getValue().data
  }

  get state(): number {
    return this.subject.getValue().state
  }

  ref(): DsRecord<Data> {
    this.refs++
    return this
  }

  unref(): DsRecord<Data> {
    this.refs--
    return this
  }

  setState(state: number, data?: Data): void {
    this.subject.next({ state, data: data !== undefined ? data : this.data })
  }

  subscribe(
    callback: (record: DsRecord<Data>, opaque: unknown) => void,
    opaque?: unknown,
  ): DsRecord<Data> {
    const subscription = this.subject.subscribe(() =>
      callback(this as unknown as DsRecord<Data>, opaque),
    )
    this.subscriptions.set(callback, subscription)
    return this
  }

  unsubscribe(
    callback: (record: DsRecord<Data>, opaque: unknown) => void,
    _opaque?: unknown,
  ): DsRecord<Data> {
    const sub = this.subscriptions.get(callback)
    if (sub) {
      sub.unsubscribe()
      this.subscriptions.delete(callback)
    }
    return this
  }

  get<P extends string | string[]>(path: P): Get<Data, P>
  get(): Data
  get(path?: string): unknown {
    return path ? jsonPath.get(this.data, path) : this.data
  }

  set(data: Data): void
  set<P extends string>(path: P, data: Get<Data, P>): void
  set(pathOrData: unknown, value?: unknown): void {
    this._fromProvider = false
    this.version = `${parseInt(this.version, 10) + 1}`
    if (value !== undefined) {
      this.subject.next({
        state: SERVER,
        data: jsonPath.set(this.data, pathOrData, value) as Data,
      })
    } else {
      this.subject.next({
        state: SERVER,
        data: pathOrData as Data,
      })
    }
  }

  // Real client passes version as second argument to the updater
  update(updater: (data: Data, version: string) => Data, options?: UpdateOptions): Promise<void>
  update<P extends string>(
    path: P,
    updater: (data: Get<Data, P>, version: string) => Get<Data, P>,
    options?: UpdateOptions,
  ): Promise<void>
  async update(
    pathOrUpdater: string | ((...args: never[]) => unknown),
    updaterOrOptions?: UpdateOptions | ((...args: never[]) => unknown),
    optionsOrNil?: UpdateOptions,
  ): Promise<void> {
    const path = typeof pathOrUpdater === 'string' ? pathOrUpdater : undefined
    const updater =
      typeof pathOrUpdater === 'function'
        ? pathOrUpdater
        : typeof updaterOrOptions === 'function'
          ? updaterOrOptions
          : undefined

    if (!updater) {
      throw new Error('no updater')
    }

    const options: UpdateOptions | undefined =
      optionsOrNil ?? (typeof updaterOrOptions !== 'function' ? updaterOrOptions : undefined)

    await this.when(SERVER, { timeout: options?.timeout ?? 60e3 })

    const prev = path ? jsonPath.get(this.data, path) : (this.data as unknown)
    const next = (updater as (data: unknown, version: string) => unknown)(prev, this.version)

    if (prev === next) {
      return
    }

    const targetData = path ? jsonPath.set(this.data, path, next) : next
    this.set(targetData as Data)
  }

  when(): Promise<DsRecord<Data>>
  when(options: WhenOptions): Promise<DsRecord<Data>>
  when(state: number, options?: WhenOptions): Promise<DsRecord<Data>>
  async when(
    stateOrOptions?: number | WhenOptions,
    optionsOrNil?: WhenOptions,
  ): Promise<DsRecord<Data>> {
    const options = typeof stateOrOptions === 'number' ? optionsOrNil : (stateOrOptions ?? {})
    const state = typeof stateOrOptions === 'number' ? stateOrOptions : (options?.state ?? SERVER)
    const timeout = options?.timeout ?? 60e3
    await firstValueFrom(
      this.subject.pipe(
        rxjs.filter((s) => s.state >= state),
        rxjs.timeout({ first: timeout }),
      ),
    )
    return this
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
