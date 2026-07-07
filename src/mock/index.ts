/**
 * Public API for the in-memory mock deepstream client. The real client
 * (createDeepstream) is wired to the in-memory MockDeepstreamServer through
 * MockConnection (see ./connection.ts). This module exposes the factory,
 * the test controller, and the JSON record-name helpers.
 */
import * as C from '../constants/constants.js'
import createDeepstream from '../client.js'
import type { DeepstreamClient, DeepstreamClientOptions, DeepstreamError } from '../client.js'
import type { RpcMethodDef } from '../rpc/rpc-handler.js'
import { MockDeepstreamServer } from './connection.ts'

export { MockConnection, MockDeepstreamServer } from './connection.ts'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateMockDeepstreamOptions extends DeepstreamClientOptions {
  /** Log in automatically (default true). */
  login?: boolean
  /** Auth data returned by the server; client.user becomes authData.id. */
  authData?: { id?: string } | null
}

/**
 * Creates a REAL deepstream client wired to an in-memory MockDeepstreamServer.
 *
 * Client errors are collected into `errors` (and do not throw) — assert on
 * the array in tests. Use `settle()` to wait for message traffic to quiesce.
 */
export function createMockDeepstream<
  Records extends Record<string, unknown> = Record<string, unknown>,
  Methods extends Record<string, RpcMethodDef> = Record<string, RpcMethodDef>,
>(
  options?: CreateMockDeepstreamOptions,
): {
  client: DeepstreamClient<Records, Methods>
  server: MockDeepstreamServer
  errors: DeepstreamError[]
  settle: () => Promise<void>
} {
  const { login = true, authData = null, ...clientOptions } = options ?? {}

  const server = new MockDeepstreamServer({ authData })
  // Microtask-scheduled SYNC batching makes get()/sync round-trips (and
  // settle()) timer-free; overridable through options.
  const syncSchedule = clientOptions.syncSchedule ?? server.scheduleSync
  if (syncSchedule === server.scheduleSync) {
    server._microtaskSync = true
  }
  const client = createDeepstream<Records, Methods>('ws://mock.deepstream.internal', {
    ...clientOptions,
    syncSchedule,
    createConnection: server.createConnection,
  })

  const errors: DeepstreamError[] = []
  client.on('error', (err) => {
    errors.push(err)
  })

  if (login) {
    client.login({}, () => {})
  }

  return { client, server, errors, settle: server.settle }
}

// ---------------------------------------------------------------------------
// JSON record name helpers
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

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Test controller: drives records into states and inspects/manipulates the
 * server. Server-side effects are asynchronous, so after setRecordState (or
 * any server manipulation) `await controller.settle()` before asserting.
 */
export class MockDeepstreamClientController<
  Records extends Record<string, unknown> = Record<string, unknown>,
  Methods extends Record<string, RpcMethodDef> = Record<string, RpcMethodDef>,
> {
  readonly server: MockDeepstreamServer
  readonly errors: DeepstreamError[]
  private _client: DeepstreamClient<Records, Methods>

  constructor(
    client: DeepstreamClient<Records, Methods>,
    server: MockDeepstreamServer,
    errors: DeepstreamError[],
  ) {
    this._client = client
    this.server = server
    this.errors = errors
  }

  settle(): Promise<void> {
    return this.server.settle()
  }

  /**
   * Drives the client record into a state the way production does:
   *  - SERVER   → server-originated update
   *  - PROVIDER → update from a simulated provider on another connection
   *  - STALE    → provider update followed by provider withdrawal
   *  - CLIENT   → not per-record: use server.dropConnection()
   *  - VOID     → not forceable: records are VOID only before their first read
   * Omitting `data` keeps the record's current server-side data.
   */
  setRecordState(name: string, state: number, data?: unknown): void {
    const payload = data !== undefined ? data : (this.server.getRecord(name)?.data ?? {})
    if (state === C.RECORD_STATE.SERVER) {
      this.server.put(name, payload)
    } else if (state === C.RECORD_STATE.PROVIDER) {
      this.server.put(name, payload, { provider: true })
    } else if (state === C.RECORD_STATE.STALE) {
      this.server.put(name, payload, { provider: true })
      this.server.setHasProvider(name, false)
    } else if (state === C.RECORD_STATE.CLIENT) {
      throw new Error(
        'setRecordState(CLIENT): CLIENT is connection-scoped — use server.dropConnection()',
      )
    } else {
      throw new Error(
        `setRecordState(${state}): records are VOID only before their first read — use a fresh record`,
      )
    }
  }

  /** The (callback, opaque) subscription pairs registered on the record. */
  getRecordSubscriptions(name: string): Array<[unknown, unknown]> {
    const record = this._client.record.getRecord(name)
    try {
      const arr =
        ((record as unknown as { _subscriptions?: unknown[] })._subscriptions as unknown[]) ?? []
      const pairs: Array<[unknown, unknown]> = []
      for (let n = 0; n < arr.length; n += 2) {
        pairs.push([arr[n], arr[n + 1]])
      }
      return pairs
    } finally {
      record.unref()
    }
  }

  /**
   * In-place reset between tests: wipes all client- and server-side state
   * (records, providers, rpc, event subscriptions, pending traffic, collected
   * errors) while keeping the client instance and its connection usable — safe
   * to call from beforeEach with a module-level singleton client.
   *
   * Reaches into the real handlers' internals; this module is versioned
   * together with them and the test suite pins the behavior.
   */
  cleanup(): void {
    type Destroyable = { _$destroy(): void }
    const client = this._client as unknown as {
      record: {
        _records: Map<string, Record<string, unknown>>
        _listeners: Map<string, Destroyable>
        _pruning: Set<unknown>
        _patching: Map<unknown, unknown>
        _updating: Map<unknown, unknown>
        _putting: Map<unknown, unknown>
        _syncQueue: unknown[]
        _syncMap: Map<unknown, unknown>
      }
      rpc: {
        _providers: Map<string, unknown>
        _rpcs: Map<string, unknown>
      }
      event: {
        _listeners: Map<string, Destroyable>
        _emitter: { off(): void }
      }
    }

    // Record listeners (provide()) — proper destroy stops provider streams.
    for (const listener of client.record._listeners.values()) {
      listener._$destroy()
    }
    client.record._listeners.clear()

    // Records: hard-drop all client-side record state (held references go dead).
    for (const record of client.record._records.values()) {
      record._subscriptions = null
      record._observers = null
      record._patching = null
      record._updating = null
    }
    client.record._records.clear()
    client.record._pruning.clear()
    client.record._patching.clear()
    client.record._updating.clear()
    client.record._putting.clear()
    client.record._syncQueue.length = 0
    client.record._syncMap.clear()

    // RPC: providers and in-flight makes.
    client.rpc._providers.clear()
    client.rpc._rpcs.clear()

    // Events: provide() listeners and all subscriptions.
    for (const listener of client.event._listeners.values()) {
      listener._$destroy()
    }
    client.event._listeners.clear()
    client.event._emitter.off()

    this.server.reset()
    this.errors.length = 0
  }

  /** Closes the client for good (deliberate close, no reconnect). */
  close(): void {
    this._client.close()
  }
}

/**
 * Creates a mock deepstream client: `create()` returns { client, controller }
 * (plus server/errors/settle), where client is the REAL deepstream client
 * wired to the in-memory server.
 */
export const MockDeepstreamClient = {
  create<
    Records extends Record<string, unknown> = Record<string, unknown>,
    Methods extends Record<string, RpcMethodDef> = Record<string, RpcMethodDef>,
  >(
    options?: CreateMockDeepstreamOptions,
  ): {
    client: DeepstreamClient<Records, Methods>
    controller: MockDeepstreamClientController<Records, Methods>
    server: MockDeepstreamServer
    errors: DeepstreamError[]
    settle: () => Promise<void>
  } {
    const { client, server, errors, settle } = createMockDeepstream<Records, Methods>(options)
    return {
      client,
      controller: new MockDeepstreamClientController(client, server, errors),
      server,
      errors,
      settle,
    }
  },
}
