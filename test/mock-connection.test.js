import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as rxjs from 'rxjs'
import * as C from '../src/constants/constants.js'
import { createMockDeepstream } from '../src/mock/index.ts'

const { VOID, CLIENT, SERVER, STALE, PROVIDER } = C.RECORD_STATE

// Contract tests: the REAL client running against the in-memory
// MockDeepstreamServer through options.createConnection.

const clients = []

function create(options) {
  const ctx = createMockDeepstream(options)
  clients.push(ctx.client)
  return ctx
}

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close()
  }
})

describe('connection', () => {
  it('logs in and reaches OPEN', async () => {
    const { client, settle, errors } = create()
    await settle()
    assert.equal(client.getConnectionState(), C.CONNECTION_STATE.OPEN)
    assert.deepEqual(errors, [])
  })

  it('does not open without login', async () => {
    const { client, settle } = create({ login: false })
    await settle()
    assert.equal(client.getConnectionState(), C.CONNECTION_STATE.AWAITING_AUTHENTICATION)
  })

  it('login callback receives auth data with session', async () => {
    const { client, settle } = create({ login: false, authData: { id: 'user-1' } })
    const result = await new Promise((resolve) => {
      client.login({}, (success, authData) => resolve({ success, authData }))
    })
    assert.equal(result.success, true)
    assert.equal(result.authData.id, 'user-1')
    assert.match(result.authData.session, /^mock-session-/)
    assert.equal(client.user, 'user-1')
    await settle()
  })
})

describe('records', () => {
  it('reads an unwritten record as empty SERVER data', async () => {
    const { client, settle, errors } = create()
    const record = client.record.getRecord('fresh')
    assert.equal(record.state, VOID)
    await record.when(SERVER)
    assert.equal(record.state, SERVER)
    assert.deepEqual(record.data, {})
    assert.equal(record.version, '0-00000000000000')
    record.unref()
    await settle()
    assert.deepEqual(errors, [])
  })

  it('set() round-trips through the server', async () => {
    const { client, server, settle, errors } = create()
    client.record.set('r1', { a: 1 })
    await settle()
    assert.deepEqual(server.getRecord('r1').data, { a: 1 })
    assert.match(server.getRecord('r1').version, /^1-/)
    assert.deepEqual(await client.record.get('r1'), { a: 1 })
    assert.deepEqual(errors, [])
  })

  it('set() with a path patches the record', async () => {
    const { client, server, settle } = create()
    client.record.set('r2', { a: { b: 1 } })
    client.record.set('r2', 'a.c', 2)
    await settle()
    assert.deepEqual(server.getRecord('r2').data, { a: { b: 1, c: 2 } })
  })

  it('update() applies an updater against SERVER state', async () => {
    const { client, server, settle } = create()
    client.record.set('r3', { n: 1 })
    await client.record.update('r3', (data) => ({ ...data, n: data.n + 1 }))
    await settle()
    assert.deepEqual(server.getRecord('r3').data, { n: 2 })
  })

  it('server.put() reaches a subscribed record', async () => {
    const { client, server, settle } = create()
    const record = client.record.getRecord('r4')
    await record.when(SERVER)
    server.put('r4', { fromServer: true })
    await settle()
    assert.deepEqual(record.data, { fromServer: true })
    assert.match(record.version, /^1-server-/)
    record.unref()
  })

  it('record.subscribe() fires on updates, not on subscribe', async () => {
    const { client, server, settle } = create()
    const record = client.record.getRecord('r5')
    await record.when(SERVER)
    let calls = 0
    record.subscribe(() => {
      calls += 1
    })
    assert.equal(calls, 0)
    server.put('r5', { x: 1 })
    await settle()
    assert.equal(calls, 1)
    record.unref()
  })

  it('observe() emits distinct data at SERVER state', async () => {
    const { client, server, settle } = create()
    const seen = []
    const subscription = client.record.observe('r6').subscribe((data) => seen.push(data))
    await settle()
    server.put('r6', { v: 1 })
    await settle()
    server.put('r6', { v: 1 }) // same payload, new version — dataOnly dedupes
    await settle()
    server.put('r6', { v: 2 })
    await settle()
    assert.deepEqual(seen, [{}, { v: 1 }, { v: 2 }])
    subscription.unsubscribe()
  })

  it('observe2() reports name/version/state/data', async () => {
    const { client, settle } = create()
    client.record.set('r7', { a: 1 })
    await settle()
    const state = await rxjs.firstValueFrom(client.record.observe2('r7', SERVER))
    assert.equal(state.name, 'r7')
    assert.equal(state.state, SERVER)
    assert.match(state.version, /^1-/)
    assert.deepEqual(state.data, { a: 1 })
  })

  it('getRecord returns the same instance and tracks refs', async () => {
    const { client, settle } = create()
    const a = client.record.getRecord('r8')
    const b = client.record.getRecord('r8')
    assert.equal(a, b)
    assert.equal(a.refs, 2)
    a.unref()
    b.unref()
    await settle()
  })
})

describe('providers (listen round-trip)', () => {
  it('provide() serves matching records through LISTEN/ACCEPT', async () => {
    const { client, server, settle, errors } = create()
    const dispose = client.record.provide('^weather/.*', (name) =>
      rxjs.of({ city: name.split('/')[1], temp: 22 }),
    )
    const record = client.record.getRecord('weather/oslo')
    await record.when(PROVIDER)
    assert.equal(record.state, PROVIDER)
    assert.deepEqual(record.data, { city: 'oslo', temp: 22 })
    assert.match(record.version, /^INF-/)
    assert.deepEqual(server.listenPatterns, ['^weather/.*'])
    record.unref()
    dispose()
    await settle()
    assert.deepEqual(errors, [])
  })

  it('provider emissions update the record', async () => {
    const { client, settle } = create()
    const subject = new rxjs.BehaviorSubject({ n: 1 })
    client.record.provide('^live/.*', () => subject)
    const record = client.record.getRecord('live/x')
    await record.when(PROVIDER)
    assert.deepEqual(record.data, { n: 1 })
    subject.next({ n: 2 })
    await settle()
    assert.deepEqual(record.data, { n: 2 })
    assert.equal(record.state, PROVIDER)
    record.unref()
  })

  it('provider withdrawal (null) leaves the record STALE', async () => {
    const { client, settle } = create()
    const subject = new rxjs.BehaviorSubject({ n: 1 })
    client.record.provide('^live2/.*', () => subject)
    const record = client.record.getRecord('live2/x')
    await record.when(PROVIDER)
    subject.next(null)
    await settle()
    assert.equal(record.state, STALE)
    assert.deepEqual(record.data, { n: 1 }) // data preserved
    record.unref()
  })

  it('cannot set() a provided record', async () => {
    const { client, settle, errors } = create()
    client.record.provide('^prov/.*', () => rxjs.of({ a: 1 }))
    const record = client.record.getRecord('prov/x')
    await record.when(PROVIDER)
    record.set({ b: 2 })
    await settle()
    assert.equal(errors.length, 1)
    assert.equal(errors[0].message, 'cannot set')
    assert.equal(errors[0].event, C.EVENT.USER_ERROR)
    record.unref()
  })

  it('promotes another accepted provider when the active one unprovides', async () => {
    const { client, settle } = create()
    const disposeA = client.record.provide('^multi/x$', () => rxjs.of({ from: 'a' }))
    const record = client.record.getRecord('multi/x')
    await record.when(PROVIDER)
    assert.deepEqual(record.data, { from: 'a' })
    // Second listener matching the same record; first stays active.
    client.record.provide('^multi/.*', () => rxjs.of({ from: 'b' }))
    await settle()
    assert.deepEqual(record.data, { from: 'a' })
    disposeA()
    await settle()
    assert.equal(record.state, PROVIDER)
    assert.deepEqual(record.data, { from: 'b' })
    record.unref()
  })
})

describe('controller-style server manipulation', () => {
  it('put(provider: true) simulates a provider on another connection', async () => {
    const { client, server, settle } = create()
    const record = client.record.getRecord('ext/1')
    await record.when(SERVER)
    server.put('ext/1', { remote: true }, { provider: true })
    await settle()
    assert.equal(record.state, PROVIDER)
    assert.deepEqual(record.data, { remote: true })
    assert.match(record.version, /^INF-/)

    server.setHasProvider('ext/1', false)
    await settle()
    assert.equal(record.state, STALE)
    record.unref()
  })

  it('a fresh subscriber sees hasProvider from the read reply', async () => {
    const { client, server, settle } = create()
    server.put('ext/2', { remote: true }, { provider: true })
    const record = client.record.getRecord('ext/2')
    await record.when(PROVIDER)
    assert.equal(record.state, PROVIDER)
    record.unref()
    await settle()
  })
})

describe('rpc', () => {
  // NOTE: rpc.make() before the connection is OPEN is silently dropped by the
  // real client (the request is never re-sent nor failed) — a genuine client
  // quirk this harness surfaced. Tests therefore settle() before making.

  it('round-trips provide/make', async () => {
    const { client, settle, errors } = create()
    client.rpc.provide('sum', (data) => data.a + data.b)
    await settle()
    assert.equal(await client.rpc.make('sum', { a: 2, b: 3 }), 5)
    assert.deepEqual(errors, [])
  })

  it('supports explicit response.send', async () => {
    const { client, settle } = create()
    client.rpc.provide('echo', (data, response) => {
      response.send({ echoed: data })
    })
    await settle()
    assert.deepEqual(await client.rpc.make('echo', 'hi'), { echoed: 'hi' })
  })

  it('rejects with NO_RPC_PROVIDER when nobody provides', async () => {
    const { client, settle } = create()
    await settle()
    await assert.rejects(client.rpc.make('missing', null), (err) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, 'NO_RPC_PROVIDER')
      assert.equal(err.rpcName, 'missing')
      return true
    })
  })

  it('rejection routes to NO_RPC_PROVIDER', async () => {
    const { client, settle } = create()
    client.rpc.provide('picky', (data, response) => {
      response.reject()
    })
    await settle()
    await assert.rejects(client.rpc.make('picky', null), /NO_RPC_PROVIDER/)
  })

  it('only the error message crosses the wire', async () => {
    const { client, settle } = create()
    client.rpc.provide('boom', () => {
      throw Object.assign(new Error('kaboom'), { code: 'CUSTOM', extra: 42 })
    })
    await settle()
    await assert.rejects(client.rpc.make('boom', { in: 1 }), (err) => {
      assert.equal(err.message, 'kaboom')
      assert.equal(err.code, undefined) // custom props do not survive
      assert.equal(err.extra, undefined)
      assert.equal(err.rpcName, 'boom')
      assert.deepEqual(err.rpcData, { in: 1 })
      return true
    })
  })

  it('server.makeRpc calls a client provider', async () => {
    const { client, server, settle } = create()
    client.rpc.provide('double', (n) => n * 2)
    await settle()
    assert.equal(await server.makeRpc('double', 21), 42)
  })
})

describe('events', () => {
  it('delivers server-side events to subscribers', async () => {
    const { client, server, settle } = create()
    const got = []
    client.event.subscribe('ev1', (data) => got.push(data))
    await settle()
    server.emitEvent('ev1', { x: 1 })
    server.emitEvent('other', { x: 2 })
    await settle()
    assert.deepEqual(got, [{ x: 1 }])
  })

  it('local emit reaches local subscribers exactly once', async () => {
    const { client, settle } = create()
    await settle()
    const got = []
    client.event.subscribe('ev2', (data) => got.push(data))
    client.event.emit('ev2', 'hello')
    await settle()
    assert.deepEqual(got, ['hello'])
  })

  it('event.provide() serves events through the listen round-trip', async () => {
    const { client, settle, errors } = create()
    const got = []
    client.event.provide('^tick/.*', (name) => rxjs.of(`from ${name}`), {})
    client.event.subscribe('tick/1', (data) => got.push(data))
    await settle()
    assert.deepEqual(got, ['from tick/1'])
    assert.deepEqual(errors, [])
  })
})

describe('connection loss', () => {
  it('records drop to CLIENT and recover on reconnect', async () => {
    const { client, server, settle } = create()
    client.record.set('c1', { a: 1 })
    await settle()
    const record = client.record.getRecord('c1')
    await record.when(SERVER)

    server.dropConnection()
    assert.equal(record.state, CLIENT)
    assert.equal(client.getConnectionState(), C.CONNECTION_STATE.RECONNECTING)
    assert.deepEqual(record.data, { a: 1 }) // data preserved

    server.restoreConnection()
    await settle()
    assert.equal(client.getConnectionState(), C.CONNECTION_STATE.OPEN)
    assert.equal(record.state, SERVER)
    assert.deepEqual(record.data, { a: 1 })
    record.unref()
  })

  it('in-flight RPCs fail with ECONNRESET', async () => {
    const { client, server, settle } = create()
    client.rpc.provide('slow', () => new Promise(() => {}))
    await settle()
    const pending = client.rpc.make('slow', null)
    await settle()
    server.dropConnection()
    await assert.rejects(pending, (err) => {
      assert.equal(err.code, 'ECONNRESET')
      return true
    })
  })

  it('pending set() while disconnected is flushed on reconnect', async () => {
    const { client, server, settle } = create()
    const record = client.record.getRecord('c2')
    await record.when(SERVER)
    server.dropConnection()
    record.set({ offline: true })
    assert.equal(record.state, CLIENT)
    server.restoreConnection()
    await settle()
    assert.deepEqual(server.getRecord('c2').data, { offline: true })
    assert.equal(record.state, SERVER)
    record.unref()
  })

  it('events resubscribe after reconnect', async () => {
    const { client, server, settle } = create()
    const got = []
    client.event.subscribe('ev3', (data) => got.push(data))
    await settle()
    server.dropConnection()
    server.restoreConnection()
    await settle()
    server.emitEvent('ev3', 1)
    await settle()
    assert.deepEqual(got, [1])
  })

  it('providers re-listen and serve again after reconnect', async () => {
    const { client, server } = create()
    client.record.provide('^re/.*', () => rxjs.of({ ok: true }))
    const record = client.record.getRecord('re/1')
    await record.when(PROVIDER)
    server.dropConnection()
    assert.equal(record.state, CLIENT)
    server.restoreConnection()
    await record.when(PROVIDER)
    assert.deepEqual(record.data, { ok: true })
    record.unref()
  })

  it('close() is deliberate: no reconnect, records go CLIENT', async () => {
    const { client, settle } = create()
    const record = client.record.getRecord('c3')
    await record.when(SERVER)
    client.close()
    assert.equal(client.getConnectionState(), C.CONNECTION_STATE.CLOSED)
    assert.equal(record.state, CLIENT)
    record.unref()
    await settle()
  })
})
