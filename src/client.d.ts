import type DsRecord from './record/record.js'
import type { Paths, Get } from './record/record.js'
import type RecordHandler from './record/record-handler.js'
import type { RecordStats, ProvideOptions, SyncOptions } from './record/record-handler.js'
import type EventHandler from './event/event-handler.js'
import type { EventStats } from './event/event-handler.js'
import type RpcHandler from './rpc/rpc-handler.js'
import type { RpcStats, RpcMethodDef } from './rpc/rpc-handler.js'

export default function <
  Records extends Record<string, unknown> = Record<string, unknown>,
  Methods extends Record<string, RpcMethodDef> = Record<string, RpcMethodDef>,
>(url: string, options?: unknown): DeepstreamClient<Records, Methods>

export type {
  DsRecord,
  RecordHandler,
  EventHandler,
  RpcHandler,
  RpcMethodDef,
  ProvideOptions,
  SyncOptions,
  Paths,
  Get,
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

export interface DeepstreamClient<
  Records extends Record<string, unknown> = Record<string, unknown>,
  Methods extends Record<string, RpcMethodDef> = Record<string, RpcMethodDef>,
> {
  nuid: () => string
  event: EventHandler
  rpc: RpcHandler<Methods>
  record: RecordHandler<Records>
  user: string | null
  on: (evt: EventName, callback: (...args: unknown[]) => void) => void
  off: (evt: EventName, callback: (...args: unknown[]) => void) => void
  getConnectionState: () => ConnectionStateName
  close: () => void
  login: unknown
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
