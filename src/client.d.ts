import type DsRecord from './record/record.js'
import type { Paths, Get } from './record/record.js'
import type RecordHandler from './record/record-handler.js'
import type { RecordStats, ProvideOptions, SyncOptions } from './record/record-handler.js'
import type EventHandler from './event/event-handler.js'
import type { EventStats, EventProvideOptions } from './event/event-handler.js'
import type RpcHandler from './rpc/rpc-handler.js'
import type { RpcStats, RpcMethodDef } from './rpc/rpc-handler.js'

export interface DeepstreamClientOptions {
  reconnectIntervalIncrement?: number
  maxReconnectInterval?: number
  maxReconnectAttempts?: number
  maxPacketSize?: number
  batchSize?: number
  schedule?: ((fn: () => void) => void) | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logger?: any
}

export default function <
  Records extends Record<string, unknown> = Record<string, unknown>,
  Methods extends Record<string, RpcMethodDef> = Record<string, RpcMethodDef>,
>(url: string, options?: DeepstreamClientOptions): DeepstreamClient<Records, Methods>

export type {
  DsRecord,
  RecordHandler,
  EventHandler,
  RpcHandler,
  RpcMethodDef,
  ProvideOptions,
  EventProvideOptions,
  SyncOptions,
  Paths,
  Get,
  ConnectionStateName,
  DeepstreamErrorEventName,
}

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
type ConnectionStateKey = keyof ConnectionStateConstants
type ConnectionStateName = ConnectionStateConstants[ConnectionStateKey]

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
type EventKey = keyof EventConstants
type EventName = EventConstants[EventKey]
type DeepstreamErrorEventName = Exclude<
  EventName,
  'connectionStateChanged' | 'connected' | 'MAX_RECONNECTION_ATTEMPTS_REACHED'
>

export interface DeepstreamError extends Error {
  topic?: string
  event?: EventName | null
  data?: unknown
}

export interface DeepstreamMessage {
  raw: string | null
  topic: string | null
  action: string | null
  data: string[]
}

export interface DeepstreamClientEventMap {
  connectionStateChanged: (state: ConnectionStateName) => void
  connected: (connected: boolean) => void
  MAX_RECONNECTION_ATTEMPTS_REACHED: (attempt: number) => void
  error: (error: DeepstreamError) => void
  recv: (message: DeepstreamMessage) => void
  send: (message: DeepstreamMessage) => void
}

type DeepstreamErrorEventMap = {
  [K in DeepstreamErrorEventName]: (error: DeepstreamError) => void
}

export interface DeepstreamClient<
  Records extends Record<string, unknown> = Record<string, unknown>,
  Methods extends Record<string, RpcMethodDef> = Record<string, RpcMethodDef>,
> {
  nuid: () => string
  event: EventHandler
  rpc: RpcHandler<Methods>
  record: RecordHandler<Records>
  user: string | null
  on<K extends keyof (DeepstreamClientEventMap & DeepstreamErrorEventMap)>(
    evt: K,
    callback: (DeepstreamClientEventMap & DeepstreamErrorEventMap)[K],
  ): this
  off<K extends keyof (DeepstreamClientEventMap & DeepstreamErrorEventMap)>(
    evt: K,
    callback: (DeepstreamClientEventMap & DeepstreamErrorEventMap)[K],
  ): this
  getConnectionState: () => ConnectionStateName
  close: () => void
  login(callback: (success: boolean, authData: unknown) => void): this
  login(
    authParams: Record<string, unknown>,
    callback: (success: boolean, authData: unknown) => void,
  ): this
  stats: {
    record: RecordStats
    rpc: RpcStats
    event: EventStats
  }

  isSameOrNewer(a: string, b: string): boolean

  CONSTANTS: {
    CONNECTION_STATE: ConnectionStateConstants
    RECORD_STATE: RecordStateConstants
    EVENT: EventConstants
  }
}
