import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as rxjs from 'rxjs'
import { MockDeepstreamClient } from '../src/mock/index.ts'

// Ported from the original hand-written-mock suite (`@nxtedition/ds-mock`),
// re-run against the REAL deepstream client wired to MockDeepstreamServer.
//
// The new mock is asynchronous — server effects (set/put/provide/emit,
// controller.setRecordState) land on later ticks — so tests `await settle()`
// after fire-and-forget calls and `await` the promise APIs (get/get2/update/
// when/make). Divergences from the old mock are noted inline where a test's
// original assertion had to change (version format, error channel, provider
// composition, event.provide now working, etc.).

let ds
let server
let errors
let settle

beforeEach(async () => {
  const mock = MockDeepstreamClient.create()
  ds = mock.client
  server = mock.server
  errors = mock.errors
  settle = mock.settle
  await settle() // connection reaches OPEN
})

afterEach(() => {
  ds.close()
})

// ---------------------------------------------------------------------------
// RecordHandler — set / get
// ---------------------------------------------------------------------------
describe('RecordHandler set/get', () => {
  test('overwrites the full record on subsequent sets', async () => {
    ds.record.set('test:record', { a: 1 })
    await settle()
    ds.record.set('test:record', { b: 2 })
    assert.deepEqual(await ds.record.get('test:record'), { b: 2 })
  })

  test('gets a sub-path', async () => {
    ds.record.set('test:record', { nested: { value: 42 } })
    assert.equal(await ds.record.get('test:record', 'nested.value'), 42)
  })

  test('sets a sub-path while preserving other fields', async () => {
    ds.record.set('test:record', { a: 1, b: 2 })
    await settle()
    ds.record.set('test:record', 'a', 99)
    assert.deepEqual(await ds.record.get('test:record'), { a: 99, b: 2 })
  })
})

// ---------------------------------------------------------------------------
// RecordHandler — observe
// ---------------------------------------------------------------------------
describe('RecordHandler observe', () => {
  test('fresh record emits empty data once it reaches SERVER', async () => {
    const values = []
    const sub = ds.record.observe('test:record').subscribe((v) => values.push(v))
    await settle()
    assert.deepEqual(values, [{}])
    sub.unsubscribe()
  })

  test('emits the current value once at SERVER state', async () => {
    ds.record.set('test:record', { a: 1 })
    await settle()
    const values = []
    const sub = ds.record.observe('test:record').subscribe((v) => values.push(v))
    await settle()
    assert.deepEqual(values, [{ a: 1 }])
    sub.unsubscribe()
  })

  test('set() on a SERVER record emits over the initial value', async () => {
    const values = []
    const sub = ds.record.observe('test:record').subscribe((v) => values.push(v))
    await settle() // initial {}
    ds.record.set('test:record', { a: 1 })
    await settle()
    assert.deepEqual(values, [{}, { a: 1 }])
    sub.unsubscribe()
  })

  test('emits on every subsequent set', async () => {
    const values = []
    const sub = ds.record.observe('test:record').subscribe((v) => values.push(v))
    await settle()
    ds.record.set('test:record', { a: 1 })
    await settle()
    ds.record.set('test:record', { a: 2 })
    await settle()
    assert.deepEqual(values, [{}, { a: 1 }, { a: 2 }])
    sub.unsubscribe()
  })

  test('observe with path filters to the sub-path', async () => {
    ds.record.set('test:record', { nested: { value: 1 } })
    await settle()
    const values = []
    const sub = ds.record.observe('test:record', 'nested.value').subscribe((v) => values.push(v))
    await settle()
    ds.record.set('test:record', 'nested.value', 2)
    await settle()
    assert.deepEqual(values, [1, 2])
    sub.unsubscribe()
  })

  test('observe with VOID threshold emits immediately even before the read', () => {
    const values = []
    const sub = ds.record.observe('test:record', ds.record.VOID).subscribe((v) => values.push(v))
    assert.equal(values.length, 1) // VOID record satisfies a VOID threshold
    sub.unsubscribe()
  })

  test('observe with PROVIDER threshold only emits once a provider is active', async () => {
    const values = []
    const sub = ds.record
      .observe('test:record', ds.record.PROVIDER)
      .subscribe((v) => values.push(v))
    await settle()
    assert.equal(values.length, 0) // SERVER < PROVIDER
    ds.record.provide('test:record', () => ({ provided: true }))
    await settle()
    assert.deepEqual(values, [{ provided: true }])
    sub.unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// RecordHandler — observe2
// ---------------------------------------------------------------------------
describe('RecordHandler observe2', () => {
  test('emits metadata alongside data', async () => {
    ds.record.set('test:record', { a: 1 })
    await settle()
    const values = []
    const sub = ds.record.observe2('test:record').subscribe((v) => values.push(v))
    await settle()
    const entry = values.at(-1)
    assert.equal(entry.name, 'test:record')
    assert.equal(entry.state, ds.record.SERVER)
    assert.deepEqual(entry.data, { a: 1 })
    sub.unsubscribe()
  })

  test('version reflects client writes and carries a rev suffix', async () => {
    ds.record.set('test:record', { a: 1 })
    await settle()
    ds.record.set('test:record', { a: 2 })
    await settle()
    // Real versions match /^\d+-/ (record.js _makeVersion); not `${n}-mock`.
    const result = await ds.record.get2('test:record')
    assert.match(result.version, /^2-/)
  })
})

// ---------------------------------------------------------------------------
// RecordHandler — update
// ---------------------------------------------------------------------------
describe('RecordHandler update', () => {
  test('updates the whole record via an updater', async () => {
    ds.record.set('test:record', { count: 0 })
    await ds.record.update('test:record', (data) => ({ ...data, count: data.count + 1 }))
    assert.deepEqual(await ds.record.get('test:record'), { count: 1 })
  })

  test('updates a sub-path while preserving other fields', async () => {
    ds.record.set('test:record', { a: 10, b: 20 })
    await ds.record.update('test:record', 'a', (v) => (v ?? 0) + 5)
    assert.deepEqual(await ds.record.get('test:record'), { a: 15, b: 20 })
  })

  test('update increments version', async () => {
    ds.record.set('test:record', { v: 0 })
    await settle()
    const before = (await ds.record.get2('test:record')).version
    assert.match(before, /^1-/)
    await ds.record.update('test:record', (d) => ({ ...d, v: 1 }))
    const after = (await ds.record.get2('test:record')).version
    assert.match(after, /^2-/)
  })

  test('updater receives (data, version) — matches real client signature', async () => {
    ds.record.set('test:record', { v: 0 })
    await settle()
    const versionBeforeUpdate = (await ds.record.get2('test:record')).version
    const receivedArgs = []
    await ds.record.update('test:record', (data, version) => {
      receivedArgs.push(data, version)
      return { ...data, v: 1 }
    })
    assert.deepEqual(receivedArgs[0], { v: 0 })
    assert.equal(receivedArgs[1], versionBeforeUpdate)
  })

  test('update is a no-op when updater returns same reference', async () => {
    ds.record.set('test:record', { v: 0 })
    await settle()
    const versionBefore = (await ds.record.get2('test:record')).version
    await ds.record.update('test:record', (d) => d) // same ref → no write
    assert.equal((await ds.record.get2('test:record')).version, versionBefore)
  })

  test('update() waits for SERVER state before applying', async () => {
    // Hold the record below SERVER by dropping the connection (CLIENT state);
    // update() must wait until it recovers to SERVER before applying.
    ds.record.set('test:record', { count: 1 })
    await settle()
    server.dropConnection()

    let applied = false
    const updatePromise = ds.record.update('test:record', (data) => {
      applied = true
      return { ...data, extra: true }
    })
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(applied, false) // still waiting for SERVER state

    server.restoreConnection()
    await updatePromise
    assert.equal(applied, true)
    assert.deepEqual(await ds.record.get('test:record'), { count: 1, extra: true })
  })

  test('update() works on a fresh record without prior set/provide', async () => {
    await ds.record.update('test:record', (d) => ({ ...d, added: true }))
    assert.deepEqual(await ds.record.get('test:record'), { added: true })
  })
})

// ---------------------------------------------------------------------------
// RecordHandler — provide
// ---------------------------------------------------------------------------
describe('RecordHandler provide', () => {
  test('provides data for newly accessed records matching the pattern', async () => {
    ds.record.provide('test:.*', () => ({ provided: true }))
    assert.deepEqual(await ds.record.get('test:something', ds.record.PROVIDER), { provided: true })
  })

  test('applies provider to already-existing records', async () => {
    const values = []
    const sub = ds.record.observe('test:record').subscribe((v) => values.push(v))
    await settle()
    ds.record.provide('test:record', () => ({ provided: true }))
    await settle()
    assert.deepEqual(values.at(-1), { provided: true })
    sub.unsubscribe()
  })

  test('provider using an Observable streams updates', async () => {
    const subject = new rxjs.BehaviorSubject({ n: 0 })
    ds.record.provide('test:record', () => subject)
    const values = []
    // Observe at PROVIDER threshold so only provider values are seen (a plain
    // observe would emit a leading {} from the empty server read first).
    const sub = ds.record
      .observe('test:record', ds.record.PROVIDER)
      .subscribe((v) => values.push(v))
    await settle()
    subject.next({ n: 1 })
    await settle()
    subject.next({ n: 2 })
    await settle()
    assert.deepEqual(values, [{ n: 0 }, { n: 1 }, { n: 2 }])
    sub.unsubscribe()
  })

  test('disposing the only provider makes the record go STALE', async () => {
    const dispose = ds.record.provide('test:.*', () => ({ provided: true }))
    const record = ds.record.getRecord('test:record')
    await record.when(ds.record.PROVIDER)
    dispose()
    await settle()
    assert.equal(record.state, ds.record.STALE)
  })

  test('disposing a provider preserves existing data', async () => {
    const dispose = ds.record.provide('test:.*', () => ({ provided: true }))
    const record = ds.record.getRecord('test:record')
    await record.when(ds.record.PROVIDER)
    dispose()
    await settle()
    assert.deepEqual(record.data, { provided: true })
  })

  test('null return from callback means no provider is installed', async () => {
    ds.record.provide('test:.*', () => null)
    const record = ds.record.getRecord('test:record')
    await record.when(ds.record.SERVER)
    assert.equal(record.state, ds.record.SERVER) // no provider → plain SERVER
    assert.deepEqual(record.data, {})
  })

  test('provider receives the record name', async () => {
    const receivedNames = []
    ds.record.provide('test:.*', (name) => {
      receivedNames.push(name)
      return { name }
    })
    await ds.record.get('test:foo', ds.record.PROVIDER)
    await ds.record.get('test:bar', ds.record.PROVIDER)
    assert.deepEqual(receivedNames.slice().sort(), ['test:bar', 'test:foo'])
  })

  // dropped: "last registered provider wins" and "falls back to previous
  // provider on dispose" encoded the old mock's multi-provider-per-pattern
  // fallthrough. The real client is one-listener-per-pattern (duplicates
  // throw); cross-pattern provider promotion is covered in
  // mock-connection.test.js.
})

// ---------------------------------------------------------------------------
// MockRecord — ref / unref
// ---------------------------------------------------------------------------
describe('MockRecord ref/unref', () => {
  test('tracks reference count', () => {
    // getRecord() itself refs the record (record-handler.js:235), so a freshly
    // fetched record starts at 1; a second getRecord() refs the same instance.
    const record = ds.record.getRecord('test:record')
    assert.equal(record.refs, 1)
    ds.record.getRecord('test:record') // getRecord() refs the same instance again
    assert.equal(record.refs, 2)
    record.ref()
    record.ref()
    assert.equal(record.refs, 4)
    record.unref()
    assert.equal(record.refs, 3)
  })
})

// ---------------------------------------------------------------------------
// MockRecord — subscribe / unsubscribe
// ---------------------------------------------------------------------------
describe('MockRecord subscribe/unsubscribe', () => {
  test('callback is invoked on each change but not on subscribe', async () => {
    const record = ds.record.getRecord('test:record')
    await record.when(ds.record.SERVER)
    const calls = []
    const cb = () => calls.push(record.data)
    record.subscribe(cb)
    ds.record.set('test:record', { v: 1 })
    ds.record.set('test:record', { v: 2 })
    assert.equal(calls.length, 2) // synchronous emits on a SERVER record
    record.unsubscribe(cb)
  })

  test('unsubscribe stops receiving updates', async () => {
    const record = ds.record.getRecord('test:record')
    await record.when(ds.record.SERVER)
    const calls = []
    const cb = () => calls.push(record.data)
    record.subscribe(cb)
    record.unsubscribe(cb)
    ds.record.set('test:record', { v: 1 })
    assert.equal(calls.length, 0)
  })
})

// ---------------------------------------------------------------------------
// MockRecord — get
// ---------------------------------------------------------------------------
describe('MockRecord get', () => {
  test('returns full data without a path', async () => {
    ds.record.set('test:record', { a: 1 })
    await settle()
    assert.deepEqual(ds.record.getRecord('test:record').get(), { a: 1 })
  })

  test('returns value at path', async () => {
    ds.record.set('test:record', { nested: { value: 42 } })
    await settle()
    assert.equal(ds.record.getRecord('test:record').get('nested.value'), 42)
  })
})

// ---------------------------------------------------------------------------
// MockRecord — when
// ---------------------------------------------------------------------------
describe('MockRecord when', () => {
  test('resolves once the record reaches SERVER', async () => {
    ds.record.set('test:record', { v: 1 })
    const record = ds.record.getRecord('test:record')
    const result = await record.when()
    assert.equal(result, record)
  })

  test('resolves once a provider raises state to PROVIDER', async () => {
    const record = ds.record.getRecord('test:record')
    const subject = new rxjs.BehaviorSubject({ ready: true })
    const promise = record.when(ds.record.PROVIDER)
    ds.record.provide('test:record', () => subject)
    assert.equal(await promise, record)
  })

  test('resolves for a fresh record when waiting for VOID', async () => {
    const record = ds.record.getRecord('test:record')
    const result = await record.when(ds.record.VOID)
    assert.equal(result, record)
  })

  test('rejects on timeout when state threshold is never reached', async () => {
    const record = ds.record.getRecord('test:record')
    await assert.rejects(record.when(ds.record.PROVIDER, { timeout: 10 }))
  })
})

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------
describe('MockRpcHandler', () => {
  test('make() supports async providers', async () => {
    ds.rpc.provide('slow', (data) => Promise.resolve(data.value * 2))
    await settle()
    assert.equal(await ds.rpc.make('slow', { value: 5 }), 10)
  })

  test('provide() disposer removes the provider', async () => {
    const dispose = ds.rpc.provide('greet', () => 'hello')
    await settle()
    dispose?.()
    await settle()
    await assert.rejects(ds.rpc.make('greet'), /NO_RPC_PROVIDER/)
  })

  test('duplicate provide surfaces PROVIDER_EXISTS and keeps the first provider', async () => {
    // Divergence: routed through client.on('error') (into `errors`), not a
    // synchronous throw.
    ds.rpc.provide('fn', () => 'first')
    ds.rpc.provide('fn', () => 'second')
    await settle()
    assert.ok(errors.some((e) => e.event === ds.CONSTANTS.EVENT.PROVIDER_EXISTS))
    assert.equal(await ds.rpc.make('fn'), 'first')
  })

  test('stats.listeners reflects registered providers', () => {
    ds.rpc.provide('a', (_d, res) => res.send(null))
    ds.rpc.provide('b', (_d, res) => res.send(null))
    assert.equal(ds.rpc.stats.listeners, 2)
  })

  test('response.error() rejects make()', async () => {
    ds.rpc.provide('fail', (_data, res) => res.error('oops'))
    await settle()
    await assert.rejects(ds.rpc.make('fail'), /oops/)
  })

  test('response guards against double-completion', async () => {
    // Ported from the MockRpcResponse unit test: a second completion throws.
    let secondThrew = false
    ds.rpc.provide('once', (_data, res) => {
      res.send('ok')
      try {
        res.send('again')
      } catch {
        secondThrew = true
      }
    })
    await settle()
    assert.equal(await ds.rpc.make('once'), 'ok')
    assert.equal(secondThrew, true)
  })

  test('unprovide() removes a provider', async () => {
    ds.rpc.provide('fn', () => 'hi')
    await settle()
    ds.rpc.unprovide('fn')
    await settle()
    await assert.rejects(ds.rpc.make('fn'), /NO_RPC_PROVIDER/)
  })

  test('make() with callback — success path', async () => {
    ds.rpc.provide('add', (data) => data.a + data.b)
    await settle()
    const result = await new Promise((resolve, reject) => {
      ds.rpc.make('add', { a: 3, b: 4 }, (err, value) => (err ? reject(err) : resolve(value)))
    })
    assert.equal(result, 7)
  })

  test('make() with callback — error path', async () => {
    ds.rpc.provide('boom', (_d, res) => res.error('bad'))
    await settle()
    const err = await new Promise((resolve) => {
      ds.rpc.make('boom', undefined, (e) => resolve(e))
    })
    assert.ok(err)
    assert.equal(err.message, 'bad')
  })

  test('make() with callback — NO_RPC_PROVIDER', async () => {
    const err = await new Promise((resolve) => {
      ds.rpc.make('missing', undefined, (e) => resolve(e))
    })
    assert.ok(err instanceof Error)
    assert.equal(err.message, 'NO_RPC_PROVIDER')
  })
})

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
describe('MockEventHandler', () => {
  test('emit() calls all local subscribers', () => {
    const received = []
    ds.event.subscribe('topic', (d) => received.push(d))
    ds.event.subscribe('topic', (d) => received.push(d))
    ds.event.emit('topic', { msg: 'hi' })
    assert.deepEqual(received, [{ msg: 'hi' }, { msg: 'hi' }])
  })

  test('emit() only calls subscribers for the matching topic', () => {
    const received = []
    ds.event.subscribe('topic-a', (d) => received.push(d))
    ds.event.emit('topic-b', 'nope')
    assert.equal(received.length, 0)
  })

  test('unsubscribe() stops a specific subscriber', () => {
    const received = []
    const cb = (d) => received.push(d)
    ds.event.subscribe('topic', cb)
    ds.event.unsubscribe('topic', cb)
    ds.event.emit('topic', 'ignored')
    assert.equal(received.length, 0)
  })

  test('emit() without data delivers undefined', () => {
    let received = 'sentinel'
    ds.event.subscribe('topic', (d) => (received = d))
    ds.event.emit('topic')
    assert.equal(received, undefined)
  })

  test('once() with one callback reused across events keeps the once guarantee', () => {
    // Real once() passes the event NAME first: callback(name, data).
    const received = []
    const cb = (name, d) => received.push([name, d])
    ds.event.once('a', cb)
    ds.event.once('b', cb)

    ds.event.emit('a', 'a1')
    ds.event.emit('a', 'a2') // must NOT fire again
    ds.event.emit('b', 'b1')
    ds.event.emit('b', 'b2') // must NOT fire again

    assert.deepEqual(received, [
      ['a', 'a1'],
      ['b', 'b1'],
    ])
  })
})

// ---------------------------------------------------------------------------
// MockDeepstreamClient — utility methods
// ---------------------------------------------------------------------------
describe('MockDeepstreamClient', () => {
  test('nuid() returns unique strings', () => {
    const ids = new Set([ds.nuid(), ds.nuid(), ds.nuid(), ds.nuid(), ds.nuid()])
    assert.equal(ids.size, 5)
  })

  test('user has no id for the default (empty) auth data', () => {
    assert.ok(ds.user == null)
  })

  test('on()/off() return this for chaining', () => {
    const cb = () => {}
    assert.equal(ds.on('connectionStateChanged', cb), ds)
    assert.equal(ds.off('connectionStateChanged', cb), ds)
  })

  test('isSameOrNewer() — simple numeric versions', () => {
    assert.ok(ds.isSameOrNewer('5-abc', '5-abc'))
    assert.ok(ds.isSameOrNewer('6-abc', '5-abc'))
    assert.ok(!ds.isSameOrNewer('4-abc', '5-abc'))
  })

  test('isSameOrNewer() — I-prefix (provider) versions are always newest', () => {
    assert.ok(ds.isSameOrNewer('INF-abc', '999-xyz'))
    assert.ok(!ds.isSameOrNewer('999-xyz', 'INF-abc'))
  })

  // dropped: "cleanup() resets nuid counter" — nuid is xuid in the real
  // client and is never reset/repeated.
})

// ---------------------------------------------------------------------------
// RecordHandler — get2
// ---------------------------------------------------------------------------
describe('RecordHandler get2', () => {
  test('resolves with full metadata object', async () => {
    ds.record.set('test:record', { a: 1 })
    await settle()
    const result = await ds.record.get2('test:record')
    assert.equal(result.name, 'test:record')
    assert.equal(result.state, ds.record.SERVER)
    assert.match(result.version, /^1-/)
    assert.deepEqual(result.data, { a: 1 })
  })

  test('respects state threshold like get()', async () => {
    const subject = new rxjs.Subject()
    ds.record.provide('test:record', () => subject)
    const promise = ds.record.get2('test:record', ds.record.PROVIDER)
    await settle()
    subject.next({ ready: true })
    const result = await promise
    assert.equal(result.state, ds.record.PROVIDER)
    assert.deepEqual(result.data, { ready: true })
  })

  test('resolves at path like get()', async () => {
    ds.record.set('test:record', { nested: { value: 99 } })
    const result = await ds.record.get2('test:record', 'nested.value')
    assert.equal(result.data, 99)
  })
})

// ---------------------------------------------------------------------------
// RecordHandler — getAsync
// ---------------------------------------------------------------------------
describe('RecordHandler getAsync', () => {
  test('returns async:false when record is already at the required state', async () => {
    ds.record.set('test:record', { a: 1 })
    await settle()
    const result = ds.record.getAsync('test:record')
    assert.equal(result.async, false)
    assert.deepEqual(result.value, { a: 1 })
  })

  test('returns async:true and resolves once state is reached', async () => {
    const subject = new rxjs.Subject()
    ds.record.provide('test:record', () => subject)
    const result = ds.record.getAsync('test:record', ds.record.PROVIDER)
    assert.equal(result.async, true)
    assert.ok(result.value instanceof Promise)
    await settle()
    subject.next({ count: 1 })
    assert.deepEqual(await result.value, { count: 1 })
  })

  test('returns async:false at path when data is already available', async () => {
    ds.record.set('test:record', { nested: { value: 42 } })
    await settle()
    const result = ds.record.getAsync('test:record', 'nested.value')
    assert.equal(result.async, false)
    assert.equal(result.value, 42)
  })
})

// ---------------------------------------------------------------------------
// MockEventHandler — on / once / off / observe / provide / stats
// ---------------------------------------------------------------------------
describe('MockEventHandler on/once/off', () => {
  test('on() is an alias for subscribe() and returns this', () => {
    const received = []
    assert.equal(
      ds.event.on('topic', (d) => received.push(d)),
      ds.event,
    )
    ds.event.emit('topic', 1)
    assert.deepEqual(received, [1])
  })

  test('off() is an alias for unsubscribe() and returns this', () => {
    const received = []
    const cb = (d) => received.push(d)
    ds.event.on('topic', cb)
    assert.equal(ds.event.off('topic', cb), ds.event)
    ds.event.emit('topic', 'ignored')
    assert.equal(received.length, 0)
  })

  test('on/off can be chained', () => {
    const cb = () => {}
    assert.doesNotThrow(() => ds.event.on('a', cb).on('b', cb).off('a', cb).off('b', cb))
  })

  test('once() fires exactly once then auto-removes', () => {
    const received = []
    ds.event.once('topic', (name, d) => received.push([name, d]))
    ds.event.emit('topic', 1)
    ds.event.emit('topic', 2)
    assert.deepEqual(received, [['topic', 1]])
  })

  test('off() with the original callback does not cancel a pending once()', () => {
    // once() registers an anonymous wrapper; off(name, cb) only matches the
    // exact function, so the wrapper still fires.
    const received = []
    const cb = (name, d) => received.push([name, d])
    ds.event.once('topic', cb)
    ds.event.off('topic', cb)
    ds.event.emit('topic', 'delivered')
    assert.deepEqual(received, [['topic', 'delivered']])
  })
})

describe('MockEventHandler observe', () => {
  test('returns an Observable that emits on each local emit', () => {
    const received = []
    const sub = ds.event.observe('topic').subscribe((d) => received.push(d))
    ds.event.emit('topic', 'a')
    ds.event.emit('topic', 'b')
    assert.deepEqual(received, ['a', 'b'])
    sub.unsubscribe()
  })

  test('unsubscribing the Observable stops delivery', () => {
    const received = []
    const sub = ds.event.observe('topic').subscribe((d) => received.push(d))
    ds.event.emit('topic', 1)
    sub.unsubscribe()
    ds.event.emit('topic', 2)
    assert.deepEqual(received, [1])
  })

  test('observe() does not emit past events (not a BehaviorSubject)', () => {
    ds.event.emit('topic', 'before')
    const received = []
    const sub = ds.event.observe('topic').subscribe((d) => received.push(d))
    assert.equal(received.length, 0)
    sub.unsubscribe()
  })
})

describe('MockEventHandler connected / stats', () => {
  test('stats.listeners counts provide() listeners, not subscriptions', async () => {
    ds.event.subscribe('a', () => {})
    ds.event.subscribe('b', () => {})
    await settle()
    assert.equal(ds.event.stats.listeners, 0) // no provide() listeners
    assert.equal(ds.event.stats.events, 2)
  })

  test('stats.events counts distinct event names with subscribers', () => {
    ds.event.subscribe('x', () => {})
    ds.event.subscribe('x', () => {})
    ds.event.subscribe('y', () => {})
    assert.equal(ds.event.stats.events, 2)
  })

  test('stats.emitted counts total emit() calls', () => {
    ds.event.emit('a', 1)
    ds.event.emit('b', 2)
    ds.event.emit('a', 3)
    assert.equal(ds.event.stats.emitted, 3)
  })
})

// ---------------------------------------------------------------------------
// MockDeepstreamClient — CONSTANTS
// ---------------------------------------------------------------------------
describe('MockDeepstreamClient CONSTANTS', () => {
  test('CONSTANTS.EVENT contains expected keys', () => {
    const { EVENT } = ds.CONSTANTS
    assert.equal(EVENT.CONNECTED, 'connected')
    assert.equal(EVENT.CONNECTION_STATE_CHANGED, 'connectionStateChanged')
    assert.equal(EVENT.TIMEOUT, 'TIMEOUT')
    assert.equal(EVENT.NOT_PROVIDED, undefined)
  })

  test('CONSTANTS.RECORD_STATE values match handler constants', () => {
    const { RECORD_STATE } = ds.CONSTANTS
    assert.equal(RECORD_STATE.VOID, ds.record.VOID)
    assert.equal(RECORD_STATE.SERVER, ds.record.SERVER)
    assert.equal(RECORD_STATE.PROVIDER, ds.record.PROVIDER)
  })
})

// ===========================================================================
// Fidelity tests — behaviors that must match the real client.
// ===========================================================================
describe('fidelity: record.set', () => {
  test('set with deep-equal data is a no-op (no version bump)', async () => {
    ds.record.set('test:record', { a: 1 })
    await settle()
    const version = (await ds.record.get2('test:record')).version
    ds.record.set('test:record', { a: 1 }) // deep-equal → no-op
    await settle()
    assert.equal((await ds.record.get2('test:record')).version, version)
  })

  test('set at a path with a deep-equal value is a no-op', async () => {
    ds.record.set('test:record', { a: { b: 1 }, c: 2 })
    await settle()
    const version = (await ds.record.get2('test:record')).version
    ds.record.set('test:record', 'a', { b: 1 })
    await settle()
    assert.equal((await ds.record.get2('test:record')).version, version)
  })

  test('whole-record set requires a plain object', () => {
    assert.throws(() => ds.record.set('test:record', 'a string'), /invalid argument/)
    assert.throws(() => ds.record.set('test:record', [1, 2]), /invalid argument/)
    assert.throws(() => ds.record.set('test:record', 42), /invalid argument/)
  })

  test('whole-record set rejects top-level keys starting with underscore', () => {
    assert.throws(() => ds.record.set('test:record', { _hidden: 1 }), /invalid argument/)
  })

  test('set rejects invalid paths', () => {
    assert.throws(() => ds.record.set('test:record', '', 1), /invalid argument/)
    assert.throws(() => ds.record.set('test:record', '_x', 1), /invalid argument/)
    assert.throws(() => ds.record.set('test:record', ['_x'], 1), /invalid argument/)
  })

  test('set on a record whose name starts with underscore errors', async () => {
    // USER_ERROR 'cannot set' routed through client.on('error') (into `errors`).
    ds.record.set('_private', { a: 1 })
    await settle()
    assert.ok(errors.some((e) => /cannot set/.test(e.message)))
  })

  test('set stores a JSON clone — caller mutations do not leak in', async () => {
    const input = { a: { b: 1 } }
    ds.record.set('test:record', input)
    input.a.b = 999
    await settle()
    assert.equal(ds.record.getRecord('test:record').get('a.b'), 1)
  })
})

describe('fidelity: record.update', () => {
  test('whole-record updater returning null is a no-op', async () => {
    ds.record.set('test:record', { a: 1 })
    await ds.record.update('test:record', () => null)
    assert.deepEqual(await ds.record.get('test:record'), { a: 1 })
  })

  test('rejects when the signal is already aborted', async () => {
    await assert.rejects(ds.record.update('test:record', (d) => d, { signal: AbortSignal.abort() }))
  })

  test('non-function updater rejects with invalid argument', async () => {
    await assert.rejects(ds.record.update('test:record', 'nope'), /invalid argument/)
  })
})

describe('fidelity: refs & dispose', () => {
  test('Symbol.dispose unrefs instead of tearing the record down', async () => {
    const subject = new rxjs.BehaviorSubject({ n: 0 })
    ds.record.provide('test:record', () => subject)
    const record = ds.record.getRecord('test:record')
    await record.when(ds.record.PROVIDER)
    const before = record.refs
    record[Symbol.dispose]()
    assert.equal(record.refs, before - 1)
    subject.next({ n: 1 })
    await settle()
    assert.deepEqual(record.data, { n: 1 }) // provider still wired
  })
})

describe('fidelity: record.subscribe', () => {
  test('does not invoke the callback on subscribe', async () => {
    ds.record.set('test:record', { a: 1 })
    await settle()
    const record = ds.record.getRecord('test:record')
    let calls = 0
    record.subscribe(() => calls++)
    assert.equal(calls, 0)
    ds.record.set('test:record', { a: 2 })
    assert.equal(calls, 1)
  })

  test('unsubscribe matches the (callback, opaque) pair', async () => {
    const record = ds.record.getRecord('test:record')
    await record.when(ds.record.SERVER)
    let calls = 0
    const cb = () => calls++
    record.subscribe(cb, 'token')
    record.unsubscribe(cb) // (cb, null) — must NOT remove (cb, 'token')
    ds.record.set('test:record', { a: 1 })
    assert.equal(calls, 1)
    record.unsubscribe(cb, 'token')
    ds.record.set('test:record', { a: 2 })
    assert.equal(calls, 1)
  })
})

describe('fidelity: record.when options', () => {
  test('timeout rejection carries code ETIMEDOUT', async () => {
    const record = ds.record.getRecord('test:record')
    await assert.rejects(record.when(ds.record.PROVIDER, { timeout: 10 }), (err) => {
      assert.equal(err.code, 'ETIMEDOUT')
      return true
    })
  })

  test('rejects an invalid state', async () => {
    const record = ds.record.getRecord('test:record')
    await assert.rejects(record.when(-1), /invalid argument/)
    await assert.rejects(record.when(NaN), /invalid argument/)
  })

  test('rejects immediately when the signal is already aborted', async () => {
    const record = ds.record.getRecord('test:record')
    await assert.rejects(
      record.when(ds.record.PROVIDER, { signal: AbortSignal.abort(), timeout: 1000 }),
      (err) => {
        assert.equal(err.name, 'AbortError')
        return true
      },
    )
  })

  test('rejects when the signal aborts while waiting', async () => {
    const ac = new AbortController()
    const record = ds.record.getRecord('test:record')
    const pending = assert.rejects(
      record.when(ds.record.PROVIDER, { signal: ac.signal, timeout: 1000 }),
    )
    ac.abort()
    await pending
  })
})

describe('fidelity: observe dedup', () => {
  test('observe(path) does not re-emit when data at the path is unchanged', async () => {
    ds.record.set('test:record', { a: 1, b: 1 })
    await settle()
    const values = []
    const sub = ds.record.observe('test:record', 'a').subscribe((v) => values.push(v))
    await settle()
    ds.record.set('test:record', 'b', 2) // unrelated path
    await settle()
    assert.deepEqual(values, [1])
    sub.unsubscribe()
  })
})

describe('fidelity: paths and selectors', () => {
  test('get supports array paths', async () => {
    ds.record.set('test:record', { a: { b: 7 } })
    assert.equal(await ds.record.get('test:record', ['a', 'b']), 7)
  })

  test('observe supports array paths', async () => {
    ds.record.set('test:record', { a: { b: 7 } })
    await settle()
    const values = []
    const sub = ds.record.observe('test:record', ['a', 'b']).subscribe((v) => values.push(v))
    await settle()
    assert.deepEqual(values, [7])
    sub.unsubscribe()
  })

  test('get supports function selectors', async () => {
    ds.record.set('test:record', { a: 3 })
    assert.equal(await ds.record.get('test:record', (d) => d.a * 2), 6)
  })

  test('record.get supports a function mapper', async () => {
    ds.record.set('test:record', { a: 3 })
    await settle()
    assert.equal(
      ds.record.getRecord('test:record').get((d) => d.a),
      3,
    )
  })

  test('record.get throws on an invalid path argument', () => {
    assert.throws(() => ds.record.getRecord('test:record').get(42), /invalid argument/)
  })
})

describe('fidelity: default state thresholds', () => {
  // Only observe() defaults to SERVER; get/get2/observe2/getAsync default to
  // CLIENT. Drop the connection to hold a record at CLIENT.

  test('observe2 emits CLIENT-state records by default', async () => {
    ds.record.set('test:record', { a: 1 })
    await settle()
    server.dropConnection() // record → CLIENT
    const values = []
    const sub = ds.record.observe2('test:record').subscribe((v) => values.push(v))
    assert.equal(values.length, 1)
    assert.equal(values[0].state, ds.record.CLIENT)
    sub.unsubscribe()
  })

  test('getAsync resolves synchronously at CLIENT state', async () => {
    ds.record.set('test:record', { a: 1 })
    await settle()
    server.dropConnection()
    const result = ds.record.getAsync('test:record')
    assert.equal(result.async, false)
    assert.deepEqual(result.value, { a: 1 })
  })

  test('observe still defaults to SERVER', async () => {
    ds.record.set('test:record', { a: 1 })
    await settle()
    server.dropConnection()
    const values = []
    const sub = ds.record.observe('test:record').subscribe((v) => values.push(v))
    assert.equal(values.length, 0) // CLIENT < SERVER
    sub.unsubscribe()
  })

  test('getAsync with an options argument is always async', async () => {
    ds.record.set('test:record', { a: 1 })
    await settle()
    const result = ds.record.getAsync('test:record', {})
    assert.equal(result.async, true)
  })
})

describe('fidelity: observe/get timeout & signal', () => {
  test('observe errors immediately when the signal is already aborted', () => {
    const seen = []
    const sub = ds.record
      .observe('test:record', ds.record.PROVIDER, { signal: AbortSignal.abort() })
      .subscribe({ next: () => {}, error: (e) => seen.push(e) })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].name, 'AbortError')
    sub.unsubscribe()
  })

  test('observe errors when the signal aborts while subscribed', () => {
    const ac = new AbortController()
    const seen = []
    const sub = ds.record
      .observe('test:record', ds.record.PROVIDER, { signal: ac.signal })
      .subscribe({ next: () => {}, error: (e) => seen.push(e) })
    ac.abort()
    assert.equal(seen.length, 1)
    sub.unsubscribe()
  })
})

describe('fidelity: record provide validation', () => {
  test('validates pattern and callback', () => {
    assert.throws(() => ds.record.provide('', () => null), /invalid argument/)
    assert.throws(() => ds.record.provide('x', 'not a function'), /invalid argument/)
  })
})

describe('fidelity: lazy record acquisition', () => {
  test('observe does not create the record until subscribed', () => {
    const calls = []
    ds.record.provide('test:.*', (name) => {
      calls.push(name)
      return { p: 1 }
    })
    const obs = ds.record.observe('test:lazy')
    assert.equal(ds.record.stats.records, 0)
    assert.equal(calls.length, 0)
    const sub = obs.subscribe(() => {})
    assert.equal(ds.record.stats.records, 1)
    sub.unsubscribe()
  })
})

describe('fidelity: getRecord & put validation', () => {
  test('getRecord validates the name', () => {
    assert.throws(() => ds.record.getRecord(''), /invalid argument/)
    assert.throws(() => ds.record.getRecord(42), /invalid argument/)
  })

  test('put validates version format', () => {
    assert.throws(() => ds.record.put('test:record', '5', {}), /invalid argument/)
    assert.throws(() => ds.record.put('test:record', 'x-5', {}), /invalid argument/)
  })

  test('put validates name and data', () => {
    assert.throws(() => ds.record.put('_x', '1-abc', {}), /invalid argument/)
    assert.throws(() => ds.record.put('test:record', '1-abc', 'str'), /invalid argument/)
  })
})

describe('fidelity: provider versions & guards', () => {
  test('provider updates carry I-prefixed versions', async () => {
    ds.record.provide('test:record', () => ({ p: 1 }))
    const record = ds.record.getRecord('test:record')
    await record.when(ds.record.PROVIDER)
    assert.equal(record.state, ds.record.PROVIDER)
    assert.match(record.version, /^INF-/)
  })

  test('update() on a provided record surfaces cannot update and does not apply', async () => {
    // Real: update() on an I-versioned record routes UPDATE_ERROR through
    // client.on('error') (into `errors`) and RESOLVES — it does not reject.
    ds.record.provide('test:record', () => ({ p: 1 }))
    const record = ds.record.getRecord('test:record')
    await record.when(ds.record.PROVIDER)
    await ds.record.update('test:record', (d) => ({ ...d, x: 1 }))
    await settle()
    assert.ok(
      errors.some(
        (e) => e.event === ds.CONSTANTS.EVENT.UPDATE_ERROR && /cannot update/.test(e.message),
      ),
    )
    assert.deepEqual(record.data, { p: 1 }) // unchanged
  })

  test('identical provider payloads are deduped', async () => {
    const subject = new rxjs.Subject()
    ds.record.provide('test:record', () => subject)
    ds.record.getRecord('test:record')
    await settle()
    const entries = []
    const sub = ds.record.observe2('test:record', ds.record.VOID).subscribe((e) => entries.push(e))
    const initial = entries.length
    subject.next({ n: 1 })
    await settle()
    subject.next({ n: 1 }) // deep-equal → same INF hash → dropped
    await settle()
    subject.next({ n: 2 })
    await settle()
    assert.equal(entries.length - initial, 2)
    sub.unsubscribe()
  })

  test('client-set versions carry a rev suffix like the real client', async () => {
    ds.record.set('test:record', { a: 1 })
    await settle()
    assert.match(ds.record.getRecord('test:record').version, /^1-.+/)
  })
})

describe('fidelity: rpc errors', () => {
  test('response.error(string) rejects with an Error carrying rpcName/rpcData', async () => {
    ds.rpc.provide('fail', (_d, res) => res.error('oops'))
    await settle()
    await assert.rejects(ds.rpc.make('fail', { x: 1 }), (err) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, 'oops')
      assert.equal(err.rpcName, 'fail')
      assert.deepEqual(err.rpcData, { x: 1 })
      return true
    })
  })

  test('a throwing provider rejects with a fresh Error — only the message crosses the wire', async () => {
    const original = new Error('boom')
    ds.rpc.provide('explode', () => {
      throw original
    })
    await settle()
    await assert.rejects(ds.rpc.make('explode'), (err) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, 'boom')
      assert.notEqual(err, original)
      assert.equal(err.rpcName, 'explode')
      return true
    })
  })

  test('callback-style make() also receives wrapped Errors', async () => {
    ds.rpc.provide('boom', (_d, res) => res.error('bad'))
    await settle()
    const err = await new Promise((resolve) => ds.rpc.make('boom', undefined, (e) => resolve(e)))
    assert.ok(err instanceof Error)
    assert.equal(err.message, 'bad')
    assert.equal(err.rpcName, 'boom')
  })
})

describe('fidelity: rpc provide/unprovide', () => {
  test('unprovide of a missing name surfaces NOT_PROVIDING', async () => {
    ds.rpc.unprovide('missing')
    await settle()
    assert.ok(errors.some((e) => e.event === ds.CONSTANTS.EVENT.NOT_PROVIDING))
  })

  test('validates name and callback', () => {
    assert.throws(() => ds.rpc.provide('', () => {}), /invalid argument/)
    assert.throws(() => ds.rpc.provide('x', 'nope'), /invalid argument/)
    assert.throws(() => ds.rpc.make(''), /invalid argument/)
  })
})

describe('fidelity: event stats & validation', () => {
  test('validates names and callbacks', () => {
    assert.throws(() => ds.event.subscribe('', () => {}), /invalid argument/)
    assert.throws(() => ds.event.subscribe('x', 'nope'), /invalid argument/)
    assert.throws(() => ds.event.unsubscribe(''), /invalid argument/)
    assert.throws(() => ds.event.emit(''), /invalid argument/)
  })
})

describe('fidelity: bound handler methods', () => {
  test('destructured handler methods work like the real client', async () => {
    const { set, get, observe } = ds.record
    const { provide, make } = ds.rpc
    const { emit, subscribe } = ds.event

    set('test:record', { a: 1 })
    assert.deepEqual(await get('test:record'), { a: 1 })
    await settle()
    const values = []
    const sub = observe('test:record').subscribe((v) => values.push(v))
    await settle()
    assert.deepEqual(values, [{ a: 1 }])
    sub.unsubscribe()

    provide('fn', () => 'ok')
    await settle()
    assert.equal(await make('fn'), 'ok')

    const received = []
    subscribe('topic', (d) => received.push(d))
    emit('topic', 7)
    assert.deepEqual(received, [7])
  })
})
