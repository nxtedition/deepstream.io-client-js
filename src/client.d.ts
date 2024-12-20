import type { Observable } from 'rxjs'

export default function <Records>(url: string, options?: unknown): DeepstreamClient<Records>

type RecordStateConstants = Readonly<{
  VOID: 0
  CLIENT: 1
  SERVER: 2
  STALE: 3
  PROVIDER: 4
}>

type ConnectionStateConstants = Readonly<{
  CLOSED: 'CLOSED'
  AWAITING_CONNECTION: 'AWAITING_CONNECTION'
  CHALLENGING: 'CHALLENGING'
  AWAITING_AUTHENTICATION: 'AWAITING_AUTHENTICATION'
  AUTHENTICATING: 'AUTHENTICATING'
  OPEN: 'OPEN'
  ERROR: 'ERROR'
  RECONNECTING: 'RECONNECTING'
}>
type ConnectionStateKey = keyof typeof ConnectionStateConstants
type ConnectionStateName = (typeof ConnectionStateConstants)[ConnectionStateKey]

type EventConstants = Readonly<{
  CONNECTION_ERROR: 'connectionError'
  CONNECTION_STATE_CHANGED: 'connectionStateChanged'
  CONNECTED: 'connected'
  MAX_RECONNECTION_ATTEMPTS_REACHED: 'MAX_RECONNECTION_ATTEMPTS_REACHED'
  CONNECTION_AUTHENTICATION_TIMEOUT: 'CONNECTION_AUTHENTICATION_TIMEOUT'
  NO_RPC_PROVIDER: 'NO_RPC_PROVIDER'
  RPC_ERROR: 'RPC_ERROR'
  TIMEOUT: 'TIMEOUT'
  UNSOLICITED_MESSAGE: 'UNSOLICITED_MESSAGE'
  MESSAGE_DENIED: 'MESSAGE_DENIED'
  NOT_CONNECTED: 'NOT_CONNECTED'
  MESSAGE_PARSE_ERROR: 'MESSAGE_PARSE_ERROR'
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED'
  MESSAGE_PERMISSION_ERROR: 'MESSAGE_PERMISSION_ERROR'
  LISTENER_EXISTS: 'LISTENER_EXISTS'
  PROVIDER_ERROR: 'PROVIDER_ERROR'
  CACHE_ERROR: 'CACHE_ERROR'
  UPDATE_ERROR: 'UPDATE_ERROR'
  USER_ERROR: 'USER_ERROR'
  REF_ERROR: 'REF_ERROR'
  PROVIDER_EXISTS: 'PROVIDER_EXISTS'
  NOT_LISTENING: 'NOT_LISTENING'
  NOT_PROVIDING: 'NOT_PROVIDING'
  LISTENER_ERROR: 'LISTENER_ERROR'
  TOO_MANY_AUTH_ATTEMPTS: 'TOO_MANY_AUTH_ATTEMPTS'
  IS_CLOSED: 'IS_CLOSED'
  RECORD_NOT_FOUND: 'RECORD_NOT_FOUND'
  NOT_SUBSCRIBED: 'NOT_SUBSCRIBED'
}>
type EventKey = keyof typeof EventConstants
type EventName = (typeof EventConstants)[EventKey]

export interface DeepstreamClient<Records = Record<string, unknown>> {
  nuid: () => string
  event: unknown
  rpc: unknown
  record: DeepstreamRecordHandler<Records>
  user: unknown
  nxt?: unknown
  on: (evt: EventName, callback: (...args: unknown[]) => void) => void
  off: (evt: EventName, callback: (...args: unknown[]) => void) => void
  getConnectionState: () => ConnectionStateName

  isSameOrNewer(a: string, b: string): boolean

  CONSTANTS: {
    CONNECTION_STATE: ConnectionStateConstants
    RECORD_STATE: RecordStateConstants
    EVENT: EventConstants
  }
}

export interface RecordStats {
  updating: number
  created: number
  destroyed: number
  records: number
  pruning: number
  patching: number
  subscriptions: number
}

export interface ProvideOptions {
  recursive?: boolean
  stringify?: ((input: unknown) => string) | null
}

export interface SyncOptions {
  signal?: AbortSignal
  timeout?: number
}

type Paths<T> = keyof T | string
type Get<Data, Path extends string> = Path extends keyof Data ? Data[Path] : unknown

export interface DeepstreamRecordHandler<Records> {
  VOID: RecordStateConstants['VOID']
  CLIENT: RecordStateConstants['CLIENT']
  PROVIDER: RecordStateConstants['PROVIDER']
  SERVER: RecordStateConstants['SERVER']
  STALE: RecordStateConstants['STALE']

  connected: boolean
  stats: RecordStats
  getRecord: <Name extends keyof Records>(name: Name) => Records[Name]

  provide: <Data>(
    pattern: string,
    callback: (key: string) => Data,
    optionsOrRecursive?: ProvideOptions | boolean,
  ) => void | (() => void)

  sync: (options: SyncOptions) => Promise<void>

  set: {
    // without path:
    <Name extends keyof Records>(name: Name, data: Records[Name]): void

    // with path:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data>>(
      name: Name,
      path: Path,
      data: Get<Data, Path>,
    ): void
  }

  update: {
    // without path:
    <Name extends keyof Records, Data extends Records[Name]>(
      name: Name,
      updater: (data: Data) => Data,
    ): Promise<void>

    // with path:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data>>(
      name: Name,
      path: Path,
      updater: (data: Get<Data, Path>) => Get<Data, Path>,
    ): Promise<void>
  }

  observe: {
    // without path:
    <Name extends keyof Records, Data extends Records[Name]>(name: Name): Observable<Data>

    // with path:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data> & string>(
      name: Name,
      path: Path,
    ): Observable<Get<Data, Path>>

    // with state:
    <Name extends keyof Records, Data extends Records[Name]>(
      name: Name,
      state: RecordStateConstants,
    ): Observable<Data>

    // with path and state:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data> & string>(
      name: Name,
      path: Path,
      state: number,
    ): Observable<Get<Data, Path>>
  }

  get: {
    // without path:
    <Name extends keyof Records, Data extends Records[Name]>(
      name: Name,
      state?: number,
    ): Promise<Data>

    // with path:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data> & string>(
      name: Name,
      path?: Path,
      state?: number,
    ): Promise<Get<Data, Path>>
  }

  observe2: {
    // without path:
    <Name extends keyof Records, Data extends Records[Name]>(
      name: Name,
    ): Observable<{
      name: Name
      version: string
      state: number
      data: Data
    }>

    // with path:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data> & string>(
      name: Name,
      path: Path,
    ): Observable<{
      name: Name
      version: Get<Data, Path>
      state: number
      data: Data
    }>

    // with state:
    <Name extends keyof Records, Data extends Records[Name]>(
      name: Name,
      state: RecordStateConstants,
    ): Observable<{
      name: Name
      version: Get<Data, Path>
      state: number
      data: Data
    }>

    // with path and state:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data> & string>(
      name: Name,
      path: Path,
      state: number,
    ): Observable<{
      name: Name
      version: Get<Data, Path>
      state: number
      data: Get<Data, Path>
    }>
  }
}
