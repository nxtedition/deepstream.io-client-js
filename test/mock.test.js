import { describe, it, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as rxjs from 'rxjs'
import {
  MockDeepstreamClient,
  MockRpcResponse,
  parseJsonRecordName,
  jsonProvider,
} from '../src/mock/index.ts'

describe('MockRecord.set', () => {
  it('sets the whole record data', () => {
    const { client } = MockDeepstreamClient.create()
    client.record.set('rec1', { type: 'file', title: 'a' })
    assert.deepEqual(client.record.getRecord('rec1').get(), { type: 'file', title: 'a' })
  })

  it('sets a path', () => {
    const { client } = MockDeepstreamClient.create()
    client.record.set('rec1', { type: 'file' })
    client.record.set('rec1', 'title', 'b')
    assert.equal(client.record.getRecord('rec1').get('type'), 'file')
    assert.equal(client.record.getRecord('rec1').get('title'), 'b')
  })

  it('clears a path on set(name, path, undefined) instead of replacing the data', () => {
    const { client } = MockDeepstreamClient.create()
    client.record.set('rec1', { type: 'file', error: { message: 'boom' } })
    // The real client disambiguates on argument count, so this clears the
    // error path; it must not turn the record data into the string 'error'.
    client.record.set('rec1', 'error', undefined)
    const record = client.record.getRecord('rec1')
    assert.equal(record.get('type'), 'file')
    assert.equal(record.get('error'), undefined)
    assert.equal(typeof record.get(), 'object')
  })
})

describe('MockRecordHandler.provide', () => {
  it('flattens providers that emit observables, like the real provider infrastructure', async () => {
    const { client } = MockDeepstreamClient.create()
    // A common provider shape: an outer observe mapped to an inner pipeline.
    client.record.provide(':stats[?]$', () => rxjs.of(rxjs.of({ status: 'ok' })))

    const value = await rxjs.firstValueFrom(
      client.record.observe('rec1:stats?').pipe(rxjs.timeout(1000)),
    )
    assert.deepEqual(value, { status: 'ok' })
  })

  it('switches to the latest inner observable across outer emissions', async () => {
    const { client } = MockDeepstreamClient.create()
    const outer$ = new rxjs.BehaviorSubject(rxjs.of({ status: 'first' }))
    client.record.provide(':stats[?]$', () => outer$)

    const values = []
    const sub = client.record.observe('rec1:stats?').subscribe((value) => values.push(value))
    outer$.next(rxjs.of({ status: 'second' }))
    sub.unsubscribe()

    assert.deepEqual(values, [{ status: 'first' }, { status: 'second' }])
  })

  it('keeps plain value providers working', async () => {
    const { client } = MockDeepstreamClient.create()
    client.record.provide(':stats[?]$', () => ({ status: 'plain' }))

    const value = await rxjs.firstValueFrom(
      client.record.observe('rec1:stats?').pipe(rxjs.timeout(1000)),
    )
    assert.deepEqual(value, { status: 'plain' })
  })
})

// ---------------------------------------------------------------------------
// Shared client/controller for the ported ds-mock tests
// ---------------------------------------------------------------------------

function disposeProvider(disposable) {
  disposable?.[Symbol.dispose]()
}

let ds
let controller

beforeEach(() => {
  const mock = MockDeepstreamClient.create()
  ds = mock.client
  controller = mock.controller
})

afterEach(() => {
  ds.close()
  controller.cleanup()
})

// ---------------------------------------------------------------------------
// RecordHandler — set / get
// ---------------------------------------------------------------------------

describe('RecordHandler set/get', () => {
  test('sets and gets a record', async () => {
    ds.record.set('test:record', { value: 'hello' })
    assert.deepEqual(await ds.record.get('test:record'), { value: 'hello' })
  })

  test('overwrites the full record on subsequent sets', async () => {
    ds.record.set('test:record', { a: 1 })
    ds.record.set('test:record', { b: 2 })
    assert.deepEqual(await ds.record.get('test:record'), { b: 2 })
  })

  test('gets a sub-path', async () => {
    ds.record.set('test:record', { nested: { value: 42 } })
    assert.equal(await ds.record.get('test:record', 'nested.value'), 42)
  })

  test('sets a sub-path while preserving other fields', () => {
    ds.record.set('test:record', { a: 1, b: 2 })
    ds.record.set('test:record', 'a', 99)
    assert.deepEqual(ds.record.getRecord('test:record').data, { a: 99, b: 2 })
  })

  test('getRecord returns the same instance', () => {
    const r1 = ds.record.getRecord('test:record')
    const r2 = ds.record.getRecord('test:record')
    assert.equal(r1, r2)
  })

  test('fresh record starts at SERVER with empty data', () => {
    const record = ds.record.getRecord('test:record')
    assert.equal(record.state, ds.record.SERVER)
    assert.deepEqual(record.data, {})
  })
})

// ---------------------------------------------------------------------------
// RecordHandler — observe
// ---------------------------------------------------------------------------

describe('RecordHandler observe', () => {
  test('fresh record emits empty data immediately on subscribe', () => {
    const values = []
    const sub = ds.record.observe('test:record').subscribe((v) => values.push(v))
    assert.equal(values.length, 1)
    assert.deepEqual(values[0], {})
    sub.unsubscribe()
  })

  test('emits the current value immediately when already at SERVER state', () => {
    ds.record.set('test:record', { a: 1 })
    const values = []
    const sub = ds.record.observe('test:record').subscribe((v) => values.push(v))
    assert.deepEqual(values, [{ a: 1 }])
    sub.unsubscribe()
  })

  test('set() on a fresh record emits over the initial empty value', () => {
    const values = []
    const sub = ds.record.observe('test:record').subscribe((v) => values.push(v))
    assert.equal(values.length, 1) // immediate emission of {}
    ds.record.set('test:record', { a: 1 })
    assert.deepEqual(values, [{}, { a: 1 }])
    sub.unsubscribe()
  })

  test('emits on every subsequent set', () => {
    const values = []
    const sub = ds.record.observe('test:record').subscribe((v) => values.push(v))
    ds.record.set('test:record', { a: 1 })
    ds.record.set('test:record', { a: 2 })
    assert.equal(values.length, 3) // {}, {a:1}, {a:2}
    assert.deepEqual(values[1], { a: 1 })
    assert.deepEqual(values[2], { a: 2 })
    sub.unsubscribe()
  })

  test('observe with path filters to the sub-path', () => {
    ds.record.set('test:record', { nested: { value: 1 } })
    const values = []
    const sub = ds.record.observe('test:record', 'nested.value').subscribe((v) => values.push(v))
    ds.record.set('test:record', 'nested.value', 2)
    assert.deepEqual(values, [1, 2])
    sub.unsubscribe()
  })

  test('observe with VOID threshold emits immediately even for fresh records', () => {
    const values = []
    const sub = ds.record.observe('test:record', ds.record.VOID).subscribe((v) => values.push(v))
    assert.equal(values.length, 1) // SERVER >= VOID
    sub.unsubscribe()
  })

  test('observe with PROVIDER threshold only emits once threshold is reached', () => {
    const values = []
    const sub = ds.record
      .observe('test:record', ds.record.PROVIDER)
      .subscribe((v) => values.push(v))
    assert.equal(values.length, 0)
    ds.record.provide('test:record', () => ({ provided: true }))
    assert.deepEqual(values, [{ provided: true }])
    sub.unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// RecordHandler — observe2
// ---------------------------------------------------------------------------

describe('RecordHandler observe2', () => {
  test('emits metadata alongside data', () => {
    ds.record.set('test:record', { a: 1 })
    const values = []
    const sub = ds.record.observe2('test:record').subscribe((v) => values.push(v))
    assert.equal(values.length, 1)
    const entry = values[0]
    assert.equal(entry.name, 'test:record')
    assert.equal(entry.state, ds.record.SERVER)
    assert.deepEqual(entry.data, { a: 1 })
    sub.unsubscribe()
  })

  test('version reflects number of sets', () => {
    ds.record.set('test:record', { a: 1 })
    ds.record.set('test:record', { a: 2 })
    const values = []
    const sub = ds.record.observe2('test:record').subscribe((v) => values.push(v))
    assert.equal(values[0].version, '2')
    sub.unsubscribe()
  })

  test('version in each emission matches the version at the time of that set', () => {
    const versions = []
    const sub = ds.record.observe2('test:record').subscribe((v) => versions.push(v.version))
    ds.record.set('test:record', { a: 1 })
    ds.record.set('test:record', { a: 2 })
    // initial emission at SERVER (version '0'), then '1' and '2'
    assert.deepEqual(versions, ['0', '1', '2'])
    sub.unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// RecordHandler — update
// ---------------------------------------------------------------------------

describe('RecordHandler update', () => {
  test('updates the whole record via an updater', async () => {
    ds.record.set('test:record', { count: 0 })
    await ds.record.update('test:record', (data) => {
      return { ...data, count: data.count + 1 }
    })
    assert.deepEqual(await ds.record.get('test:record'), { count: 1 })
  })

  test('updates a sub-path while preserving other fields', async () => {
    ds.record.set('test:record', { a: 10, b: 20 })
    await ds.record.update('test:record', 'a', (v) => (v ?? 0) + 5)
    assert.deepEqual(await ds.record.get('test:record'), { a: 15, b: 20 })
  })

  test('update increments version', async () => {
    ds.record.set('test:record', { v: 0 })
    const record = ds.record.getRecord('test:record')
    assert.equal(record.version, '1')
    await ds.record.update('test:record', (d) => ({ ...d, v: 1 }))
    assert.equal(record.version, '2')
  })

  test('updater receives (data, version) — matches real client signature', async () => {
    ds.record.set('test:record', { v: 0 })
    const versionBeforeUpdate = ds.record.getRecord('test:record').version
    const receivedArgs = []
    await ds.record.update('test:record', (data, version) => {
      receivedArgs.push(data, version)
      return { ...data, v: 1 }
    })
    assert.deepEqual(receivedArgs[0], { v: 0 })
    assert.equal(receivedArgs[1], versionBeforeUpdate) // version at time of update
  })

  test('update is a no-op when updater returns same reference', async () => {
    ds.record.set('test:record', { v: 0 })
    const record = ds.record.getRecord('test:record')
    const versionBefore = record.version
    await ds.record.update('test:record', (d) => d) // same ref → no write
    assert.equal(record.version, versionBefore)
  })

  test('update() waits for SERVER state before applying', async () => {
    const subject = new rxjs.Subject()
    ds.record.provide('test:record', () => subject)

    let applied = false
    const updatePromise = ds.record.update('test:record', (data) => {
      applied = true
      return { ...data, extra: true }
    })

    assert.equal(applied, false) // still waiting for SERVER state

    subject.next({ count: 1 }) // → PROVIDER state (≥ SERVER)
    await updatePromise

    assert.equal(applied, true)
    assert.deepEqual(await ds.record.get('test:record'), { count: 1, extra: true })
  })

  test('update() works on a fresh record without prior set/provide', async () => {
    // Real client: server always responds with {} for unknown records
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
    assert.deepEqual(await ds.record.get('test:something'), { provided: true })
  })

  test('applies provider to already-existing records', () => {
    const values = []
    const sub = ds.record.observe('test:record').subscribe((v) => values.push(v))
    ds.record.provide('test:.*', () => ({ provided: true }))
    assert.deepEqual(values[values.length - 1], { provided: true })
    sub.unsubscribe()
  })

  test('provider using an Observable streams updates', () => {
    const subject = new rxjs.BehaviorSubject({ n: 0 })
    ds.record.provide('test:record', () => subject)
    const values = []
    const sub = ds.record.observe('test:record').subscribe((v) => values.push(v))
    subject.next({ n: 1 })
    subject.next({ n: 2 })
    assert.deepEqual(values, [{ n: 0 }, { n: 1 }, { n: 2 }])
    sub.unsubscribe()
  })

  test('last registered provider wins for a new record', async () => {
    ds.record.provide('.*', () => ({ source: 'first' }))
    ds.record.provide('test:.*', () => ({ source: 'second' }))
    assert.deepEqual(await ds.record.get('test:record'), { source: 'second' })
  })

  test('last registered provider wins for an existing record', () => {
    ds.record.getRecord('test:record')
    ds.record.provide('.*', () => ({ source: 'first' }))
    ds.record.provide('test:.*', () => ({ source: 'second' }))
    assert.deepEqual(ds.record.getRecord('test:record').data, { source: 'second' })
  })

  test('disposing a provider falls back to the previous matching provider', () => {
    ds.record.provide('.*', () => ({ source: 'first' }))
    const dispose = ds.record.provide('test:.*', () => ({ source: 'second' }))
    ds.record.getRecord('test:record')
    disposeProvider(dispose)
    assert.deepEqual(ds.record.getRecord('test:record').data, { source: 'first' })
  })

  test('disposing the only provider makes record go STALE', () => {
    const dispose = ds.record.provide('test:.*', () => ({ provided: true }))
    ds.record.getRecord('test:record')
    disposeProvider(dispose)
    assert.equal(ds.record.getRecord('test:record').state, ds.record.STALE)
  })

  test('disposing a provider preserves existing data', () => {
    const dispose = ds.record.provide('test:.*', () => ({ provided: true }))
    ds.record.getRecord('test:record')
    disposeProvider(dispose)
    assert.deepEqual(ds.record.getRecord('test:record').data, { provided: true })
  })

  test('disposing a provider on a record set by client goes to SERVER not STALE', () => {
    // Record was set via set() (not by a provider), so _fromProvider stays false.
    // A null-returning provider is added and removed — since it never fired (null),
    // setProvider was never called with a live observable, so removing it goes to SERVER.
    ds.record.set('test:record', { a: 1 })
    const dispose = ds.record.provide('test:record', () => null) // null → no provider applied
    disposeProvider(dispose)
    assert.equal(ds.record.getRecord('test:record').state, ds.record.SERVER)
  })

  test('non-matching records are unaffected when a provider is removed', () => {
    ds.record.set('other:record', { untouched: true })
    const dispose = ds.record.provide('test:.*', () => ({ provided: true }))
    disposeProvider(dispose)
    assert.deepEqual(ds.record.getRecord('other:record').data, { untouched: true })
  })

  test('null return from callback means no provider is installed', () => {
    ds.record.provide('test:.*', () => null)
    // Provider returned null so no provider applied — falls back to SERVER with empty data
    assert.equal(ds.record.getRecord('test:record').state, ds.record.SERVER)
  })

  test('provider receives the record name', async () => {
    const receivedNames = []
    ds.record.provide('test:.*', (name) => {
      receivedNames.push(name)
      return { name }
    })
    await ds.record.get('test:foo')
    await ds.record.get('test:bar')
    assert.deepEqual(receivedNames, ['test:foo', 'test:bar'])
  })
})

// ---------------------------------------------------------------------------
// RecordHandler — stats
// ---------------------------------------------------------------------------

describe('RecordHandler stats', () => {
  test('counts records', () => {
    ds.record.getRecord('test:a')
    ds.record.getRecord('test:b')
    assert.equal(ds.record.stats.records, 2)
  })

  test('counts active observe subscriptions', () => {
    const sub1 = ds.record.observe('test:a').subscribe(() => {})
    const sub2 = ds.record.observe('test:a').subscribe(() => {})
    const sub3 = ds.record.observe('test:b').subscribe(() => {})
    assert.equal(ds.record.stats.subscriptions, 3)
    sub1.unsubscribe()
    assert.equal(ds.record.stats.subscriptions, 2)
    sub2.unsubscribe()
    sub3.unsubscribe()
    assert.equal(ds.record.stats.subscriptions, 0)
  })

  test('counts record.subscribe() calls', () => {
    const record = ds.record.getRecord('test:record')
    const cb = () => {}
    record.subscribe(cb)
    assert.equal(ds.record.stats.subscriptions, 1)
    record.unsubscribe(cb)
    assert.equal(ds.record.stats.subscriptions, 0)
  })
})

// ---------------------------------------------------------------------------
// RecordHandler — cleanup
// ---------------------------------------------------------------------------

describe('RecordHandler cleanup', () => {
  test('clears all records', () => {
    ds.record.set('test:a', { v: 1 })
    ds.record.set('test:b', { v: 2 })
    controller.cleanup()
    assert.equal(ds.record.stats.records, 0)
    // new records start at SERVER (simulating server's empty-record response)
    assert.equal(ds.record.getRecord('test:a').state, ds.record.SERVER)
  })

  test('clears all providers', () => {
    ds.record.provide('test:.*', () => ({ provided: true }))
    controller.cleanup()
    // no provider installed after cleanup — falls back to SERVER with empty data
    assert.equal(ds.record.getRecord('test:something').state, ds.record.SERVER)
  })

  test('cancels active provider subscriptions without throwing', () => {
    const subject = new rxjs.Subject()
    ds.record.provide('test:record', () => subject)
    ds.record.getRecord('test:record')
    controller.cleanup()
    assert.doesNotThrow(() => subject.next({ after: 'cleanup' }))
  })
})

// ---------------------------------------------------------------------------
// MockRecord — ref / unref
// ---------------------------------------------------------------------------

describe('MockRecord ref/unref', () => {
  test('tracks reference count', () => {
    const record = ds.record.getRecord('test:record')
    assert.equal(record.refs, 0)
    record.ref()
    record.ref()
    assert.equal(record.refs, 2)
    record.unref()
    assert.equal(record.refs, 1)
  })
})

// ---------------------------------------------------------------------------
// MockRecord — version
// ---------------------------------------------------------------------------

describe('MockRecord version', () => {
  test('starts at 0 and increments with each set', () => {
    const record = ds.record.getRecord('test:record')
    assert.equal(record.version, '0')
    ds.record.set('test:record', { a: 1 })
    assert.equal(record.version, '1')
    ds.record.set('test:record', { a: 2 })
    assert.equal(record.version, '2')
  })
})

// ---------------------------------------------------------------------------
// MockRecord — subscribe / unsubscribe
// ---------------------------------------------------------------------------

describe('MockRecord subscribe/unsubscribe', () => {
  test('callback is invoked on subscribe (BehaviorSubject fires immediately) and on change', () => {
    const record = ds.record.getRecord('test:record')
    const calls = []
    const cb = () => calls.push(record.data)
    record.subscribe(cb)
    ds.record.set('test:record', { v: 1 })
    ds.record.set('test:record', { v: 2 })
    // fires once on subscribe (VOID state) + 2 sets
    assert.equal(calls.length, 3)
    record.unsubscribe(cb)
  })

  test('unsubscribe stops receiving updates', () => {
    const record = ds.record.getRecord('test:record')
    const calls = []
    const cb = () => calls.push(record.data)
    record.subscribe(cb)
    const countAfterSubscribe = calls.length
    record.unsubscribe(cb)
    ds.record.set('test:record', { v: 1 })
    assert.equal(calls.length, countAfterSubscribe)
  })

  test('subscription is removed from the map after unsubscribe', () => {
    const record = ds.record.getRecord('test:record')
    const cb = () => {}
    record.subscribe(cb)
    assert.ok(controller.getRecordSubscriptions('test:record').has(cb))
    record.unsubscribe(cb)
    assert.ok(!controller.getRecordSubscriptions('test:record').has(cb))
  })
})

// ---------------------------------------------------------------------------
// MockRecord — get
// ---------------------------------------------------------------------------

describe('MockRecord get', () => {
  test('returns full data without a path', () => {
    ds.record.set('test:record', { a: 1 })
    assert.deepEqual(ds.record.getRecord('test:record').get(), { a: 1 })
  })

  test('returns value at path', () => {
    ds.record.set('test:record', { nested: { value: 42 } })
    assert.equal(ds.record.getRecord('test:record').get('nested.value'), 42)
  })
})

// ---------------------------------------------------------------------------
// MockRecord — when
// ---------------------------------------------------------------------------

describe('MockRecord when', () => {
  test('resolves immediately when state already satisfies the threshold', async () => {
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

  test('resolves for a VOID record when waiting for VOID', async () => {
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
  test('make() calls the registered provider and resolves with the result', async () => {
    ds.rpc.provide('add', (data) => data.a + data.b)
    const result = await ds.rpc.make('add', { a: 3, b: 4 })
    assert.equal(result, 7)
  })

  test('make() rejects with NO_RPC_PROVIDER when no provider is registered', async () => {
    await assert.rejects(ds.rpc.make('missing', undefined), (err) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, 'NO_RPC_PROVIDER')
      assert.equal(err.rpcName, 'missing')
      return true
    })
  })

  test('make() supports async providers', async () => {
    ds.rpc.provide('slow', (data) => {
      return Promise.resolve(data.value * 2)
    })
    const result = await ds.rpc.make('slow', { value: 5 })
    assert.equal(result, 10)
  })

  test('provide() disposer removes the provider', async () => {
    const dispose = ds.rpc.provide('greet', () => 'hello')
    dispose?.()
    await assert.rejects(ds.rpc.make('greet'), (err) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, 'NO_RPC_PROVIDER')
      return true
    })
  })

  test('cleanup() removes all providers', async () => {
    ds.rpc.provide('a', () => 1)
    ds.rpc.provide('b', () => 2)
    controller.cleanup()
    await assert.rejects(ds.rpc.make('a'))
    await assert.rejects(ds.rpc.make('b'))
  })

  test('later provide() call overrides earlier one for same name', async () => {
    ds.rpc.provide('fn', () => 'first')
    ds.rpc.provide('fn', () => 'second')
    assert.equal(await ds.rpc.make('fn'), 'second')
  })

  test('stats.listeners reflects registered providers', () => {
    ds.rpc.provide('a', (_d, res) => res.send(null))
    ds.rpc.provide('b', (_d, res) => res.send(null))
    assert.equal(ds.rpc.stats.listeners, 2)
  })

  test('response.send() resolves make()', async () => {
    ds.rpc.provide('greet', (_data, res) => res.send('hello'))
    assert.equal(await ds.rpc.make('greet'), 'hello')
  })

  test('response.error() rejects make()', async () => {
    ds.rpc.provide('fail', (_data, res) => res.error('oops'))
    await assert.rejects(ds.rpc.make('fail'), /oops/)
  })

  test('response.reject() rejects make()', async () => {
    ds.rpc.provide('rej', (_data, res) => res.reject())
    await assert.rejects(ds.rpc.make('rej'), /rejected/)
  })

  test('response.completed prevents double-completion', () => {
    const res = new MockRpcResponse(
      () => {},
      () => {},
    )
    res.send('ok')
    assert.throws(() => res.send('again'))
  })

  test('unprovide() removes a provider', async () => {
    ds.rpc.provide('fn', () => 'hi')
    ds.rpc.unprovide('fn')
    await assert.rejects(ds.rpc.make('fn'), (err) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, 'NO_RPC_PROVIDER')
      return true
    })
  })

  test('make() with callback — success path', (_, done) => {
    ds.rpc.provide('add', (data) => data.a + data.b)
    ds.rpc.make('add', { a: 3, b: 4 }, (err, result) => {
      assert.equal(err, null)
      assert.equal(result, 7)
      done()
    })
  })

  test('make() with callback — error path', (_, done) => {
    ds.rpc.provide('boom', (_d, res) => res.error('bad'))
    ds.rpc.make('boom', undefined, (err, result) => {
      assert.ok(err)
      assert.equal(result, undefined)
      done()
    })
  })

  test('make() with callback — NO_RPC_PROVIDER', (_, done) => {
    ds.rpc.make('missing', undefined, (err) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, 'NO_RPC_PROVIDER')
      done()
    })
  })
})

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe('MockEventHandler', () => {
  test('emit() calls all subscribers', () => {
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

  test('cleanup() removes all subscriptions', () => {
    const received = []
    ds.event.subscribe('topic', (d) => received.push(d))
    controller.cleanup()
    ds.event.emit('topic', 'ignored')
    assert.equal(received.length, 0)
  })

  test('once() with one callback reused across events keeps the once guarantee', () => {
    const received = []
    const cb = (d) => received.push(d)
    ds.event.once('a', cb)
    ds.event.once('b', cb)

    ds.event.emit('a', 'a1')
    ds.event.emit('a', 'a2') // must NOT fire again — once() already consumed
    ds.event.emit('b', 'b1')
    ds.event.emit('b', 'b2') // must NOT fire again

    assert.deepEqual(received, ['a1', 'b1'])
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

  test('getConnectionState() returns OPEN', () => {
    assert.equal(ds.getConnectionState(), 'OPEN')
  })

  test('user is null', () => {
    assert.equal(ds.user, null)
  })

  test('on()/off() do not throw and return this for chaining', () => {
    const cb = () => {}
    const ret = ds.on('connectionStateChanged', cb)
    assert.equal(ret, ds)
    const ret2 = ds.off('connectionStateChanged', cb)
    assert.equal(ret2, ds)
  })

  test('isSameOrNewer() — simple numeric versions', () => {
    assert.ok(ds.isSameOrNewer('5-abc', '5-abc')) // equal
    assert.ok(ds.isSameOrNewer('6-abc', '5-abc')) // newer
    assert.ok(!ds.isSameOrNewer('4-abc', '5-abc')) // older
  })

  test('isSameOrNewer() — I-prefix (provider) versions are always newest', () => {
    assert.ok(ds.isSameOrNewer('I-abc', '999-xyz'))
    assert.ok(!ds.isSameOrNewer('999-xyz', 'I-abc'))
  })

  test('isSameOrNewer() — handles plain integer strings (mock version format)', () => {
    assert.ok(ds.isSameOrNewer('2', '1'))
    assert.ok(ds.isSameOrNewer('1', '1'))
    assert.ok(!ds.isSameOrNewer('0', '1'))
  })

  test('cleanup() resets nuid counter', () => {
    const first = ds.nuid()
    controller.cleanup()
    const afterCleanup = ds.nuid()
    assert.equal(first, afterCleanup)
  })
})

// ---------------------------------------------------------------------------
// MockRecord — setState (direct state control for tests)
// ---------------------------------------------------------------------------

describe('MockRecord setState', () => {
  test('transitions to CLIENT state with data (optimistic write scenario)', () => {
    const record = ds.record.getRecord('test:record')
    controller.setRecordState('test:record', ds.record.CLIENT, { v: 1 })
    assert.equal(record.state, ds.record.CLIENT)
    assert.deepEqual(record.data, { v: 1 })
  })

  test('transitions to STALE state (no provider scenario)', () => {
    ds.record.set('test:record', { v: 1 })
    const record = ds.record.getRecord('test:record')
    controller.setRecordState('test:record', ds.record.STALE)
    assert.equal(record.state, ds.record.STALE)
    assert.deepEqual(record.data, { v: 1 }) // data is preserved
  })

  test('observe() respects the state threshold after setState', () => {
    // Put record in CLIENT state — below SERVER threshold
    controller.setRecordState('test:record', ds.record.CLIENT, { a: 1 })

    const serverValues = []
    const sub = ds.record
      .observe('test:record', ds.record.SERVER)
      .subscribe((v) => serverValues.push(v))
    assert.equal(serverValues.length, 0) // CLIENT < SERVER

    controller.setRecordState('test:record', ds.record.SERVER, { b: 1 })
    assert.deepEqual(serverValues, [{ b: 1 }])
    sub.unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// Deferred / timed state transitions
// ---------------------------------------------------------------------------

describe('deferred state transitions', () => {
  test('record stays VOID until provider Subject emits', () => {
    const subject = new rxjs.Subject()
    ds.record.provide('test:record', () => subject)

    const record = ds.record.getRecord('test:record')
    assert.equal(record.state, ds.record.VOID)

    subject.next({ loaded: true })
    assert.equal(record.state, ds.record.PROVIDER)
    assert.deepEqual(record.data, { loaded: true })
  })

  test('observe() streams updates from a deferred Subject provider', () => {
    const subject = new rxjs.Subject()
    ds.record.provide('test:record', () => subject)

    const values = []
    const sub = ds.record.observe('test:record').subscribe((v) => values.push(v))

    assert.equal(values.length, 0) // nothing yet

    subject.next({ step: 1 })
    subject.next({ step: 2 })
    assert.deepEqual(values, [{ step: 1 }, { step: 2 }])
    sub.unsubscribe()
  })

  test('simulating a record going STALE then being restored', () => {
    const values = []
    ds.record.set('test:record', { v: 1 })
    const sub = ds.record
      .observe2('test:record', ds.record.VOID)
      .subscribe((e) => values.push({ state: e.state, data: e.data }))

    controller.setRecordState('test:record', ds.record.STALE)
    ds.record.set('test:record', { v: 2 }) // provider restored

    assert.equal(values[0].state, ds.record.SERVER)
    assert.equal(values[1].state, ds.record.STALE)
    assert.equal(values[2].state, ds.record.SERVER)
    sub.unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// parseJsonRecordName
// ---------------------------------------------------------------------------

describe('parseJsonRecordName', () => {
  test('parses a valid JSON record name', () => {
    const result = parseJsonRecordName('{"type":"asset","id":"abc"}:permission')
    assert.deepEqual(result, {
      json: { type: 'asset', id: 'abc' },
      suffix: ':permission',
    })
  })

  test('parses a name with a query-style suffix', () => {
    const result = parseJsonRecordName('{"query":"foo"}:search?')
    assert.deepEqual(result, {
      json: { query: 'foo' },
      suffix: ':search?',
    })
  })

  test('returns null for a plain record name', () => {
    assert.equal(parseJsonRecordName('asset:general.title'), null)
  })

  test('returns null for malformed JSON', () => {
    assert.equal(parseJsonRecordName('{not json}:permission'), null)
  })

  test('returns null if there is no suffix', () => {
    assert.equal(parseJsonRecordName('{"type":"asset"}'), null)
  })
})

// ---------------------------------------------------------------------------
// jsonProvider
// ---------------------------------------------------------------------------

describe('jsonProvider', () => {
  test('provides data for a matching JSON record name', async () => {
    ds.record.provide(
      ...jsonProvider(':permission', ({ type }) => (type === 'asset' ? { canEdit: true } : null)),
    )
    assert.deepEqual(await ds.record.get('{"type":"asset"}:permission'), { canEdit: true })
  })

  test('returns null (skips) when the matcher returns null', () => {
    ds.record.provide(
      ...jsonProvider(':permission', ({ type }) => (type === 'user' ? { canEdit: true } : null)),
    )
    // type is 'asset', not 'user' → matcher returns null → no provider → SERVER with empty data
    assert.equal(ds.record.getRecord('{"type":"asset"}:permission').state, ds.record.SERVER)
  })

  test('does not match a plain record name without JSON', () => {
    const calls = []
    ds.record.provide(
      ...jsonProvider(':permission', (json) => {
        calls.push(JSON.stringify(json))
        return { provided: true }
      }),
    )
    ds.record.getRecord('asset:permission') // plain name, no JSON
    assert.equal(calls.length, 0)
  })

  test('pattern is anchored to the suffix', async () => {
    ds.record.provide(...jsonProvider(':search?', ({ query }) => ({ results: [query] })))
    assert.deepEqual(await ds.record.get('{"query":"foo"}:search?'), { results: ['foo'] })
    // Different suffix should not match (no provider → SERVER with empty data)
    assert.equal(ds.record.getRecord('{"query":"foo"}:other').state, ds.record.SERVER)
  })

  test('spreads cleanly into ds.record.provide()', async () => {
    const tuple = jsonProvider(':perm', () => ({ ok: true }))
    assert.equal(tuple.length, 2)
    assert.equal(typeof tuple[0], 'string') // pattern
    assert.equal(typeof tuple[1], 'function') // callback
    ds.record.provide(...tuple)
    assert.deepEqual(await ds.record.get('{"x":1}:perm'), { ok: true })
  })
})

// ---------------------------------------------------------------------------
// RecordHandler — get2
// ---------------------------------------------------------------------------

describe('RecordHandler get2', () => {
  test('resolves with full metadata object', async () => {
    ds.record.set('test:record', { a: 1 })
    const result = await ds.record.get2('test:record')
    assert.equal(result.name, 'test:record')
    assert.equal(result.state, ds.record.SERVER)
    assert.equal(result.version, '1')
    assert.deepEqual(result.data, { a: 1 })
  })

  test('respects state threshold like get()', async () => {
    const subject = new rxjs.Subject()
    ds.record.provide('test:record', () => subject)
    const promise = ds.record.get2('test:record', ds.record.PROVIDER)
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
  test('returns async:false when record is already at the required state', () => {
    ds.record.set('test:record', { a: 1 })
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
    subject.next({ count: 1 })
    assert.deepEqual(await result.value, { count: 1 })
  })

  test('returns async:false at path when data is already available', () => {
    ds.record.set('test:record', { nested: { value: 42 } })
    const result = ds.record.getAsync('test:record', 'nested.value')
    assert.equal(result.async, false)
    assert.equal(result.value, 42)
  })
})

// ---------------------------------------------------------------------------
// MockEventHandler — on / once / off / observe / connected / stats
// ---------------------------------------------------------------------------

describe('MockEventHandler on/once/off', () => {
  test('on() is an alias for subscribe() and returns this', () => {
    const received = []
    const ret = ds.event.on('topic', (d) => received.push(d))
    assert.equal(ret, ds.event)
    ds.event.emit('topic', 1)
    assert.deepEqual(received, [1])
  })

  test('off() is an alias for unsubscribe() and returns this', () => {
    const received = []
    const cb = (d) => received.push(d)
    ds.event.on('topic', cb)
    const ret = ds.event.off('topic', cb)
    assert.equal(ret, ds.event)
    ds.event.emit('topic', 'ignored')
    assert.equal(received.length, 0)
  })

  test('on/off can be chained', () => {
    const cb = () => {}
    assert.doesNotThrow(() => ds.event.on('a', cb).on('b', cb).off('a', cb).off('b', cb))
  })

  test('once() fires exactly once then auto-removes', () => {
    const received = []
    ds.event.once('topic', (d) => received.push(d))
    ds.event.emit('topic', 1)
    ds.event.emit('topic', 2)
    assert.deepEqual(received, [1])
  })

  test('off() removes a once() listener before it fires', () => {
    const received = []
    const cb = (d) => received.push(d)
    ds.event.once('topic', cb)
    ds.event.off('topic', cb)
    ds.event.emit('topic', 'ignored')
    assert.equal(received.length, 0)
  })
})

describe('MockEventHandler observe', () => {
  test('returns an Observable that emits on each event', () => {
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
    ds.event.emit('topic', 2) // must not arrive
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

describe('MockEventHandler provide', () => {
  test('provide() throws not implemented', () => {
    assert.throws(
      () => ds.event.provide('test:.*', () => {}, {}),
      /not implemented/,
      'should throw',
    )
  })
})

describe('MockEventHandler connected / stats', () => {
  test('connected is always true', () => {
    assert.equal(ds.event.connected, true)
  })

  test('stats.listeners counts active subscriptions', () => {
    const cb1 = () => {}
    const cb2 = () => {}
    ds.event.subscribe('a', cb1)
    ds.event.subscribe('b', cb2)
    assert.equal(ds.event.stats.listeners, 2)
    ds.event.unsubscribe('a', cb1)
    assert.equal(ds.event.stats.listeners, 1)
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

  test('cleanup() resets emitted count', () => {
    ds.event.emit('a', 1)
    controller.cleanup()
    assert.equal(ds.event.stats.emitted, 0)
  })
})

// ---------------------------------------------------------------------------
// MockDeepstreamClient — CONSTANTS.EVENT
// ---------------------------------------------------------------------------

describe('MockDeepstreamClient CONSTANTS', () => {
  test('CONSTANTS.EVENT contains expected keys', () => {
    const { EVENT } = ds.CONSTANTS
    assert.equal(EVENT.CONNECTED, 'connected')
    assert.equal(EVENT.CONNECTION_STATE_CHANGED, 'connectionStateChanged')
    assert.equal(EVENT.TIMEOUT, 'TIMEOUT')
    assert.equal(EVENT.NOT_PROVIDED, undefined) // NOT a valid event key
  })

  test('CONSTANTS.RECORD_STATE values match handler constants', () => {
    const { RECORD_STATE } = ds.CONSTANTS
    assert.equal(RECORD_STATE.VOID, ds.record.VOID)
    assert.equal(RECORD_STATE.SERVER, ds.record.SERVER)
    assert.equal(RECORD_STATE.PROVIDER, ds.record.PROVIDER)
  })
})
