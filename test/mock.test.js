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

  it('flattens observables from a foreign rxjs copy (no instanceof reliance)', async () => {
    const { client } = MockDeepstreamClient.create()
    // Simulates an observable from another rxjs copy or build: satisfies
    // rxjs.isObservable's duck-typing but is not an instance of this rxjs's
    // Observable class.
    class ForeignObservable {
      constructor(inner) {
        this.inner = inner
      }
      lift() {
        throw new Error('not used')
      }
      subscribe(...args) {
        return this.inner.subscribe(...args)
      }
      pipe(...operators) {
        return this.inner.pipe(...operators)
      }
    }
    client.record.provide(':stats[?]$', () => new ForeignObservable(rxjs.of({ status: 'foreign' })))

    const value = await rxjs.firstValueFrom(
      client.record.observe('rec1:stats?').pipe(rxjs.timeout(1000)),
    )
    assert.deepEqual(value, { status: 'foreign' })
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
    // Versions carry a '-mock' rev suffix: real versions always match /^\d+-/
    // (record.js:578-585; put() validates it, record-handler.js:420).
    assert.equal(values[0].version, '2-mock')
    sub.unsubscribe()
  })

  test('version in each emission matches the version at the time of that set', () => {
    const versions = []
    const sub = ds.record.observe2('test:record').subscribe((v) => versions.push(v.version))
    ds.record.set('test:record', { a: 1 })
    ds.record.set('test:record', { a: 2 })
    // initial emission at SERVER (version '0-mock'), then '1-mock' and '2-mock'
    assert.deepEqual(versions, ['0-mock', '1-mock', '2-mock'])
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
    assert.equal(record.version, '1-mock')
    await ds.record.update('test:record', (d) => ({ ...d, v: 1 }))
    assert.equal(record.version, '2-mock')
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
    // NOTE: this used to wait on a provider Subject, but that flow cannot work
    // against the real client: provider data carries an I-version and update()
    // then raises UPDATE_ERROR 'cannot update' (record.js:341-348). Use a
    // CLIENT-state record instead, which is what update() genuinely waits out.
    controller.setRecordState('test:record', ds.record.CLIENT, { count: 1 })

    let applied = false
    const updatePromise = ds.record.update('test:record', (data) => {
      applied = true
      return { ...data, extra: true }
    })

    assert.equal(applied, false) // still waiting for SERVER state

    controller.setRecordState('test:record', ds.record.SERVER, { count: 1 })
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
    // Real: getRecord() itself refs the record (record-handler.js:235), so a
    // freshly fetched record starts at 1, not 0.
    const record = ds.record.getRecord('test:record')
    assert.equal(record.refs, 1)
    record.ref()
    record.ref()
    assert.equal(record.refs, 3)
    record.unref()
    assert.equal(record.refs, 2)
  })
})

// ---------------------------------------------------------------------------
// MockRecord — version
// ---------------------------------------------------------------------------

describe('MockRecord version', () => {
  test('starts at 0-mock and increments with each set', () => {
    // Real versions always carry a '-<rev>' suffix (record.js:578-585); the
    // mock uses '-mock' so code parsing versions behaves like production.
    const record = ds.record.getRecord('test:record')
    assert.equal(record.version, '0-mock')
    ds.record.set('test:record', { a: 1 })
    assert.equal(record.version, '1-mock')
    ds.record.set('test:record', { a: 2 })
    assert.equal(record.version, '2-mock')
  })
})

// ---------------------------------------------------------------------------
// MockRecord — subscribe / unsubscribe
// ---------------------------------------------------------------------------

describe('MockRecord subscribe/unsubscribe', () => {
  test('callback is invoked on each change but not on subscribe', () => {
    // Real: subscribe() only registers the callback (record.js:98-108);
    // it is never invoked synchronously on subscription.
    const record = ds.record.getRecord('test:record')
    const calls = []
    const cb = () => calls.push(record.data)
    record.subscribe(cb)
    ds.record.set('test:record', { v: 1 })
    ds.record.set('test:record', { v: 2 })
    assert.equal(calls.length, 2)
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

  test('later provide() call for the same name throws and keeps the first provider', async () => {
    // Real: a duplicate provide raises PROVIDER_EXISTS through client error
    // handling — which throws without an 'error' listener (rpc-handler.js:46-49
    // + client.js:100-109) — and the first provider stays active.
    ds.rpc.provide('fn', () => 'first')
    assert.throws(() => ds.rpc.provide('fn', () => 'second'))
    assert.equal(await ds.rpc.make('fn'), 'first')
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
    // Real: reject() sends a REJECTION; with no other provider the server
    // answers with NO_RPC_PROVIDER — there is no "rejected" message.
    ds.rpc.provide('rej', (_data, res) => res.reject())
    await assert.rejects(ds.rpc.make('rej'), /NO_RPC_PROVIDER/)
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
    // Real once() passes the event NAME first: callback(name, data)
    // (event-handler.js:79-86).
    const received = []
    const cb = (name, d) => received.push([name, d])
    ds.event.once('a', cb)
    ds.event.once('b', cb)

    ds.event.emit('a', 'a1')
    ds.event.emit('a', 'a2') // must NOT fire again — once() already consumed
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
    assert.equal(result.version, '1-mock')
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
    // Real once() callbacks receive (name, data) (event-handler.js:79-86).
    const received = []
    ds.event.once('topic', (name, d) => received.push([name, d]))
    ds.event.emit('topic', 1)
    ds.event.emit('topic', 2)
    assert.deepEqual(received, [['topic', 1]])
  })

  test('off() with the original callback does not cancel a pending once()', () => {
    // Real: once() registers an anonymous wrapper; emitter.off(name, cb) only
    // matches the exact function, so the wrapper still fires
    // (event-handler.js:79-91).
    const received = []
    const cb = (name, d) => received.push([name, d])
    ds.event.once('topic', cb)
    ds.event.off('topic', cb)
    ds.event.emit('topic', 'delivered')
    assert.deepEqual(received, [['topic', 'delivered']])
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

  test('stats.listeners counts provide() listeners, not subscriptions', () => {
    // Real: stats.listeners is the number of provide() patterns; subscriptions
    // only affect stats.events (event-handler.js:34-42). The mock has no
    // event.provide(), so listeners stays 0.
    const cb1 = () => {}
    const cb2 = () => {}
    ds.event.subscribe('a', cb1)
    ds.event.subscribe('b', cb2)
    assert.equal(ds.event.stats.listeners, 0)
    assert.equal(ds.event.stats.events, 2)
    ds.event.unsubscribe('a', cb1)
    assert.equal(ds.event.stats.events, 1)
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

// ===========================================================================
// Fidelity tests — each block documents a divergence from the real client,
// citing the real implementation (src/record/record.js, record-handler.js,
// rpc-handler.js, rpc-response.js, event-handler.js, utils/legacy-listener.js).
// ===========================================================================

// ---------------------------------------------------------------------------
// Fidelity: MockRecord.set
// ---------------------------------------------------------------------------

describe('fidelity: record.set', () => {
  test('set with deep-equal data is a no-op (no version bump, no emission)', () => {
    // Real: set → _update(jsonPath.set(data, path, value, false)). jsonPath.set
    // returns the SAME reference for deep-equal values (structural sharing) and
    // _update early-returns on nextData === this._data (record.js:441-443), so
    // there is no version bump and no subscriber emission.
    ds.record.set('test:record', { a: 1 })
    const record = ds.record.getRecord('test:record')
    const version = record.version
    const values = []
    const sub = ds.record.observe2('test:record').subscribe((v) => values.push(v))
    const count = values.length
    ds.record.set('test:record', { a: 1 }) // deep-equal → no-op in the real client
    assert.equal(record.version, version)
    assert.equal(values.length, count)
    sub.unsubscribe()
  })

  test('set at a path with a deep-equal value is a no-op', () => {
    ds.record.set('test:record', { a: { b: 1 }, c: 2 })
    const record = ds.record.getRecord('test:record')
    const version = record.version
    ds.record.set('test:record', 'a', { b: 1 })
    assert.equal(record.version, version)
  })

  test('whole-record set requires a plain object (record.js:210-212)', () => {
    assert.throws(() => ds.record.set('test:record', 'a string'), /invalid argument/)
    assert.throws(() => ds.record.set('test:record', [1, 2]), /invalid argument/)
    assert.throws(() => ds.record.set('test:record', 42), /invalid argument/)
  })

  test('whole-record set rejects top-level keys starting with underscore (record.js:213-215)', () => {
    assert.throws(() => ds.record.set('test:record', { _hidden: 1 }), /invalid argument/)
  })

  test('set rejects invalid paths (record.js:216-222)', () => {
    assert.throws(() => ds.record.set('test:record', '', 1), /invalid argument/)
    assert.throws(() => ds.record.set('test:record', '_x', 1), /invalid argument/)
    assert.throws(() => ds.record.set('test:record', ['_x'], 1), /invalid argument/)
  })

  test('set on a record whose name starts with underscore errors (record.js:202-205)', () => {
    // Real: USER_ERROR 'cannot set' routed through client error handling, which
    // throws when no 'error' listener is registered (client.js:100-109).
    assert.throws(() => ds.record.set('_private', { a: 1 }), /cannot set/)
  })

  test('set stores a JSON clone — caller mutations do not leak in (jsonPath jsonClone)', () => {
    const input = { a: { b: 1 } }
    ds.record.set('test:record', input)
    input.a.b = 999
    assert.equal(ds.record.getRecord('test:record').get('a.b'), 1)
  })
})

// ---------------------------------------------------------------------------
// Fidelity: MockRecord.update
// ---------------------------------------------------------------------------

describe('fidelity: record.update', () => {
  test('whole-record updater returning null is a no-op (record.js:375)', async () => {
    // Real: `if (prev !== next && (path || next != null)) this.set(path, next)`
    // — without a path, a null/undefined updater result must NOT be written.
    ds.record.set('test:record', { a: 1 })
    await ds.record.update('test:record', () => null)
    assert.deepEqual(await ds.record.get('test:record'), { a: 1 })
  })

  test('rejects when the signal is already aborted (record.js:366-368)', async () => {
    await assert.rejects(ds.record.update('test:record', (d) => d, { signal: AbortSignal.abort() }))
  })

  test('non-function updater rejects with invalid argument (record.js:354-356)', async () => {
    await assert.rejects(ds.record.update('test:record', 'nope'), /invalid argument/)
  })
})

// ---------------------------------------------------------------------------
// Fidelity: refs & Symbol.dispose
// ---------------------------------------------------------------------------

describe('fidelity: refs & dispose', () => {
  test('getRecord() refs the record (record-handler.js:235 returns record.ref())', () => {
    const record = ds.record.getRecord('test:record')
    assert.equal(record.refs, 1)
    ds.record.getRecord('test:record')
    assert.equal(record.refs, 2)
  })

  test('Symbol.dispose unrefs instead of tearing the record down (record.js:89-91)', () => {
    // Real: dispose is a plain unref(). The mock used to run cleanup(), which
    // killed the provider subscription for every other user of the record.
    const subject = new rxjs.BehaviorSubject({ n: 0 })
    ds.record.provide('test:record', () => subject)
    const record = ds.record.getRecord('test:record')
    record[Symbol.dispose]()
    assert.equal(record.refs, 0)
    subject.next({ n: 1 })
    assert.deepEqual(record.data, { n: 1 }) // provider must still be wired
  })

  test('handler methods leave refs balanced like the real handler', async () => {
    // Real handler.set/update/get acquire the record and unref when done
    // (record-handler.js:406-413, 450-461, 518-525, observe teardown 657-674).
    ds.record.set('test:record', { a: 1 })
    await ds.record.update('test:record', (d) => ({ ...d, b: 2 }))
    await ds.record.get('test:record')
    const sub = ds.record.observe('test:record').subscribe(() => {})
    sub.unsubscribe()
    const record = ds.record.getRecord('test:record')
    assert.equal(record.refs, 1) // only our own getRecord above
  })
})

// ---------------------------------------------------------------------------
// Fidelity: MockRecord.subscribe
// ---------------------------------------------------------------------------

describe('fidelity: record.subscribe', () => {
  test('does not invoke the callback on subscribe (record.js:98-108)', () => {
    // Real: subscribe() only registers; callbacks fire on subsequent updates
    // via _emitUpdate. The mock used a BehaviorSubject which fired immediately.
    ds.record.set('test:record', { a: 1 })
    const record = ds.record.getRecord('test:record')
    let calls = 0
    record.subscribe(() => calls++)
    assert.equal(calls, 0)
    ds.record.set('test:record', { a: 2 })
    assert.equal(calls, 1)
  })

  test('unsubscribe matches the (callback, opaque) pair (record.js:116-141)', () => {
    // Real: unsubscribe(fn) defaults opaque to null and only removes an exact
    // (fn, opaque) match.
    const record = ds.record.getRecord('test:record')
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

// ---------------------------------------------------------------------------
// Fidelity: MockRecord.when options
// ---------------------------------------------------------------------------

describe('fidelity: record.when options', () => {
  test('timeout rejection carries code ETIMEDOUT (record.js:315-325)', async () => {
    const record = ds.record.getRecord('test:record')
    await assert.rejects(record.when(ds.record.PROVIDER, { timeout: 10 }), (err) => {
      assert.equal(err.code, 'ETIMEDOUT')
      return true
    })
  })

  test('rejects an invalid state (record.js:259-261)', async () => {
    const record = ds.record.getRecord('test:record')
    await assert.rejects(record.when(-1), /invalid argument/)
    await assert.rejects(record.when(NaN), /invalid argument/)
  })

  test('rejects immediately when the signal is already aborted (record.js:255-257)', async () => {
    const record = ds.record.getRecord('test:record')
    await assert.rejects(
      record.when(ds.record.PROVIDER, { signal: AbortSignal.abort(), timeout: 1000 }),
      (err) => {
        assert.equal(err.name, 'AbortError') // real rejects with signal.reason
        return true
      },
    )
  })

  test('rejects when the signal aborts while waiting (record.js:278-280, 328-331)', async () => {
    const ac = new AbortController()
    const record = ds.record.getRecord('test:record')
    const pending = assert.rejects(
      record.when(ds.record.PROVIDER, { signal: ac.signal, timeout: 1000 }),
    )
    ac.abort()
    await pending
  })
})

// ---------------------------------------------------------------------------
// Fidelity: observe dedup (dataOnly)
// ---------------------------------------------------------------------------

describe('fidelity: observe dedup', () => {
  test('observe(path) does not re-emit when data at the path is unchanged (record-handler.js:58-62)', () => {
    // Real: dataOnly subscriptions only notify when the selected data actually
    // changed (`data !== subscription.data`); structural sharing keeps refs
    // stable for untouched paths.
    ds.record.set('test:record', { a: 1, b: 1 })
    const values = []
    const sub = ds.record.observe('test:record', 'a').subscribe((v) => values.push(v))
    ds.record.set('test:record', 'b', 2) // unrelated path
    assert.deepEqual(values, [1])
    sub.unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// Fidelity: paths and selectors
// ---------------------------------------------------------------------------

describe('fidelity: paths and selectors', () => {
  test('get supports array paths (record-handler.js:559-566)', async () => {
    ds.record.set('test:record', { a: { b: 7 } })
    assert.equal(await ds.record.get('test:record', ['a', 'b']), 7)
  })

  test('observe supports array paths', () => {
    ds.record.set('test:record', { a: { b: 7 } })
    const values = []
    const sub = ds.record.observe('test:record', ['a', 'b']).subscribe((v) => values.push(v))
    assert.deepEqual(values, [7])
    sub.unsubscribe()
  })

  test('get supports function selectors (record-handler.js:559-566 + record.js:189-190)', async () => {
    ds.record.set('test:record', { a: 3 })
    assert.equal(await ds.record.get('test:record', (d) => d.a * 2), 6)
  })

  test('record.get supports a function mapper (record.js:189-190, also declared in record.d.ts)', () => {
    ds.record.set('test:record', { a: 3 })
    assert.equal(
      ds.record.getRecord('test:record').get((d) => d.a),
      3,
    )
  })

  test('record.get throws on an invalid path argument (record.js:192)', () => {
    assert.throws(() => ds.record.getRecord('test:record').get(42), /invalid argument/)
  })
})

// ---------------------------------------------------------------------------
// Fidelity: default state thresholds
// ---------------------------------------------------------------------------

describe('fidelity: default state thresholds', () => {
  // Real defaults (record-handler.js:17-33): only observe() defaults to SERVER
  // (OBSERVE_DEFAULTS.state). get/get2/observe2/getAsync default to CLIENT
  // (their defaults objects have no state; _observe falls back to CLIENT,
  // record-handler.js:488 and 551).
  test('observe2 emits CLIENT-state records by default', () => {
    controller.setRecordState('test:record', ds.record.CLIENT, { a: 1 })
    const values = []
    const sub = ds.record.observe2('test:record').subscribe((v) => values.push(v))
    assert.equal(values.length, 1)
    assert.equal(values[0].state, ds.record.CLIENT)
    sub.unsubscribe()
  })

  test('getAsync resolves synchronously at CLIENT state', () => {
    controller.setRecordState('test:record', ds.record.CLIENT, { a: 1 })
    const result = ds.record.getAsync('test:record')
    assert.equal(result.async, false)
    assert.deepEqual(result.value, { a: 1 })
  })

  test('observe still defaults to SERVER', () => {
    controller.setRecordState('test:record', ds.record.CLIENT, { a: 1 })
    const values = []
    const sub = ds.record.observe('test:record').subscribe((v) => values.push(v))
    assert.equal(values.length, 0)
    sub.unsubscribe()
  })

  test('getAsync with an options argument is always async (record-handler.js:506-508)', () => {
    ds.record.set('test:record', { a: 1 })
    const result = ds.record.getAsync('test:record', {})
    assert.equal(result.async, true)
  })
})

// ---------------------------------------------------------------------------
// Fidelity: observe/get timeout & signal
// ---------------------------------------------------------------------------

describe('fidelity: observe/get timeout & signal', () => {
  test('get rejects with ETIMEDOUT when the state is not reached in time (record-handler.js:73-98, 690-692)', async () => {
    ds.record.provide('test:record', () => new rxjs.Subject()) // record stays below SERVER
    const result = await Promise.race([
      ds.record.get('test:record', { timeout: 10 }).then(
        () => 'resolved',
        (err) => err,
      ),
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 250)),
    ])
    assert.ok(result instanceof Error, `expected an ETIMEDOUT rejection, got: ${result}`)
    assert.equal(result.code, 'ETIMEDOUT')
  })

  test('observe errors immediately when the signal is already aborted (record-handler.js:622-624)', () => {
    const errors = []
    const sub = ds.record
      .observe('test:record', ds.record.PROVIDER, { signal: AbortSignal.abort() })
      .subscribe({ next: () => {}, error: (e) => errors.push(e) })
    assert.equal(errors.length, 1)
    assert.equal(errors[0].name, 'AbortError')
    sub.unsubscribe()
  })

  test('observe errors when the signal aborts while subscribed (record-handler.js:676-679)', () => {
    const ac = new AbortController()
    const errors = []
    const sub = ds.record
      .observe('test:record', ds.record.PROVIDER, { signal: ac.signal })
      .subscribe({ next: () => {}, error: (e) => errors.push(e) })
    ac.abort()
    assert.equal(errors.length, 1)
    sub.unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// Fidelity: RecordHandler.provide / getRecord / put validation
// ---------------------------------------------------------------------------

describe('fidelity: record provide validation', () => {
  test('duplicate pattern throws (record-handler.js:252-254)', () => {
    ds.record.provide('test:.*', () => null)
    assert.throws(() => ds.record.provide('test:.*', () => null), /already provided/)
  })

  test('re-providing after dispose is allowed', () => {
    const dispose = ds.record.provide('test:.*', () => null)
    dispose()
    assert.doesNotThrow(() => ds.record.provide('test:.*', () => null))
  })

  test('validates pattern and callback (record-handler.js:238-243)', () => {
    assert.throws(() => ds.record.provide('', () => null), /invalid argument/)
    assert.throws(() => ds.record.provide('x', 'not a function'), /invalid argument/)
  })
})

describe('fidelity: lazy record acquisition', () => {
  test('observe does not create the record until subscribed (record-handler.js:681)', () => {
    // Real: the record is acquired inside the Observable subscribe function.
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
    assert.deepEqual(calls, ['test:lazy'])
    sub.unsubscribe()
  })
})

describe('fidelity: getRecord & put validation', () => {
  test('getRecord validates the name (record-handler.js:213-215)', () => {
    assert.throws(() => ds.record.getRecord(''), /invalid argument/)
    assert.throws(() => ds.record.getRecord(42), /invalid argument/)
  })

  test('put validates version format (record-handler.js:420-422)', () => {
    assert.throws(() => ds.record.put('test:record', '5', {}), /invalid argument/)
    assert.throws(() => ds.record.put('test:record', 'x-5', {}), /invalid argument/)
  })

  test('put validates name and data (record-handler.js:415-426)', () => {
    assert.throws(() => ds.record.put('_x', '1-abc', {}), /invalid argument/)
    assert.throws(() => ds.record.put('test:record', '1-abc', 'str'), /invalid argument/)
  })

  test('valid put applies version and data', () => {
    ds.record.put('test:record', '5-abc', { a: 1 })
    const record = ds.record.getRecord('test:record')
    assert.equal(record.version, '5-abc')
    assert.deepEqual(record.data, { a: 1 })
  })

  test('stats.created counts created records (record-handler.js:230-232)', () => {
    ds.record.getRecord('test:a')
    ds.record.getRecord('test:a')
    ds.record.getRecord('test:b')
    assert.equal(ds.record.stats.created, 2)
  })
})

// ---------------------------------------------------------------------------
// Fidelity: provider versions & write guards
// ---------------------------------------------------------------------------

describe('fidelity: provider versions & guards', () => {
  test('provider updates carry I-prefixed versions (legacy-listener.js:170-181)', () => {
    // Real: both listener implementations send provider values as
    // `INF-${hash(payload)}` versions.
    ds.record.provide('test:record', () => ({ p: 1 }))
    const record = ds.record.getRecord('test:record')
    assert.equal(record.state, ds.record.PROVIDER)
    assert.match(record.version, /^INF-/)
  })

  test('set() on a provided record throws cannot set (record.js:202-205)', () => {
    // Real: provided records have I-versions, and set() on an I-version record
    // raises USER_ERROR 'cannot set' (throws without an error listener).
    ds.record.provide('test:record', () => ({ p: 1 }))
    ds.record.getRecord('test:record')
    assert.throws(() => ds.record.set('test:record', { a: 1 }), /cannot set/)
  })

  test('update() on a provided record rejects cannot update (record.js:341-348)', async () => {
    ds.record.provide('test:record', () => ({ p: 1 }))
    ds.record.getRecord('test:record')
    await assert.rejects(
      ds.record.update('test:record', (d) => ({ ...d, x: 1 })),
      /cannot update/,
    )
  })

  test('identical provider payloads are deduped (legacy-listener.js:174-181)', () => {
    // Real: the listener hashes the payload and skips the send when the version
    // (hash) is unchanged, so deep-equal re-emissions never reach subscribers.
    const subject = new rxjs.Subject()
    ds.record.provide('test:record', () => subject)
    const entries = []
    const sub = ds.record.observe2('test:record', ds.record.VOID).subscribe((e) => entries.push(e))
    const initial = entries.length
    subject.next({ n: 1 })
    subject.next({ n: 1 }) // deep-equal → same INF hash → dropped in real
    subject.next({ n: 2 })
    assert.equal(entries.length - initial, 2)
    sub.unsubscribe()
  })

  test('provider emitting null withdraws the provider → STALE (legacy-listener.js:141-143 + record.js:550-567)', () => {
    // Real: a null value makes the listener reject the subscription; the server
    // reports hasProvider=false and an I-versioned record goes STALE, keeping
    // its data.
    const subject = new rxjs.BehaviorSubject({ n: 1 })
    ds.record.provide('test:record', () => subject)
    const record = ds.record.getRecord('test:record')
    assert.equal(record.state, ds.record.PROVIDER)
    subject.next(null)
    assert.equal(record.state, ds.record.STALE)
    assert.deepEqual(record.data, { n: 1 })
  })

  test('client-set versions carry a rev suffix like the real client (record.js:578-585)', () => {
    // Real versions always match /^\d+-.+/ (put() even validates this,
    // record-handler.js:420). Plain integer strings break real utils.splitRev.
    ds.record.set('test:record', { a: 1 })
    assert.match(ds.record.getRecord('test:record').version, /^1-.+/)
  })
})

// ---------------------------------------------------------------------------
// Fidelity: RPC errors
// ---------------------------------------------------------------------------

describe('fidelity: rpc errors', () => {
  test('response.error(string) rejects with an Error carrying rpcName/rpcData (rpc-handler.js:148-162)', async () => {
    // Real: the caller always receives `Object.assign(new Error(data),
    // { rpcId, rpcName, rpcData })` — never the raw value.
    ds.rpc.provide('fail', (_d, res) => res.error('oops'))
    await assert.rejects(ds.rpc.make('fail', { x: 1 }), (err) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, 'oops')
      assert.equal(err.rpcName, 'fail')
      assert.deepEqual(err.rpcData, { x: 1 })
      return true
    })
  })

  test('a throwing provider rejects with a fresh Error — only the message crosses the wire (rpc-response.js:20-32)', async () => {
    const original = new Error('boom')
    ds.rpc.provide('explode', () => {
      throw original
    })
    await assert.rejects(ds.rpc.make('explode'), (err) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, 'boom')
      assert.notEqual(err, original)
      assert.equal(err.rpcName, 'explode')
      return true
    })
  })

  test('callback-style make() also receives wrapped Errors', (_, done) => {
    ds.rpc.provide('boom', (_d, res) => res.error('bad'))
    ds.rpc.make('boom', undefined, (err) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, 'bad')
      assert.equal(err.rpcName, 'boom')
      done()
    })
  })

  test('response.reject() surfaces NO_RPC_PROVIDER like the real server round-trip', async () => {
    // Real: reject() sends a REJECTION (rpc-response.js:11-18); with no other
    // provider the server answers with a NO_RPC_PROVIDER error — the caller
    // never sees a "rejected" message.
    ds.rpc.provide('rej', (_d, res) => res.reject())
    await assert.rejects(ds.rpc.make('rej'), (err) => {
      assert.equal(err.message, 'NO_RPC_PROVIDER')
      return true
    })
  })
})

// ---------------------------------------------------------------------------
// Fidelity: RPC provide/unprovide semantics
// ---------------------------------------------------------------------------

describe('fidelity: rpc provide/unprovide', () => {
  test('duplicate provide throws PROVIDER_EXISTS and keeps the first provider (rpc-handler.js:46-49)', async () => {
    // Real: a second provide for the same name raises PROVIDER_EXISTS through
    // client error handling — which throws when no 'error' listener is
    // registered (client.js:100-109) — and the first provider stays active.
    ds.rpc.provide('fn', () => 'first')
    assert.throws(() => ds.rpc.provide('fn', () => 'second'))
    assert.equal(await ds.rpc.make('fn'), 'first')
  })

  test('unprovide of a missing name throws NOT_PROVIDING (rpc-handler.js:70-73)', () => {
    assert.throws(() => ds.rpc.unprovide('missing'))
  })

  test('validates name and callback (rpc-handler.js:38-44, 83-96)', () => {
    assert.throws(() => ds.rpc.provide('', () => {}), /invalid argument/)
    assert.throws(() => ds.rpc.provide('x', 'nope'), /invalid argument/)
    assert.throws(() => ds.rpc.make(''), /invalid argument/)
  })
})

// ---------------------------------------------------------------------------
// Fidelity: events
// ---------------------------------------------------------------------------

describe('fidelity: event once/off', () => {
  test('once() callback receives (name, data) like the real client (event-handler.js:79-86)', () => {
    // NOTE: the real implementation passes the event NAME as the first argument
    // (`callback(name, ...args)`), even though event-handler.d.ts declares
    // `(data) => void`. The mock mirrors the runtime behavior; the impl/types
    // mismatch is flagged for the real client.
    const received = []
    ds.event.once('topic', (...args) => received.push(args))
    ds.event.emit('topic', 42)
    assert.deepEqual(received, [['topic', 42]])
  })

  test('off() with the original callback does not remove a pending once() wrapper (event-handler.js:79-91)', () => {
    // Real: once() registers an anonymous wrapper via subscribe(); emitter.off
    // only matches the exact function (or fn.fn, which the wrapper does not
    // set), so off(name, cb) cannot cancel a pending once(name, cb).
    let calls = 0
    const cb = () => calls++
    ds.event.once('topic', cb)
    ds.event.off('topic', cb)
    ds.event.emit('topic')
    assert.equal(calls, 1)
  })
})

describe('fidelity: event stats & validation', () => {
  test('stats.listeners counts provide() listeners, not subscriptions (event-handler.js:34-42)', () => {
    // Real: `listeners: this._listeners.size` counts provide() patterns;
    // subscriptions only influence `events` (distinct subscribed names).
    ds.event.subscribe('a', () => {})
    ds.event.subscribe('a', () => {})
    ds.event.subscribe('b', () => {})
    assert.equal(ds.event.stats.listeners, 0) // the mock has no event.provide()
    assert.equal(ds.event.stats.events, 2)
  })

  test('validates names and callbacks (event-handler.js:44-50, 59-64, 103-106)', () => {
    assert.throws(() => ds.event.subscribe('', () => {}), /invalid argument/)
    assert.throws(() => ds.event.subscribe('x', 'nope'), /invalid argument/)
    assert.throws(() => ds.event.unsubscribe(''), /invalid argument/)
    assert.throws(() => ds.event.emit(''), /invalid argument/)
  })
})

// ---------------------------------------------------------------------------
// Fidelity: bound handler methods
// ---------------------------------------------------------------------------

describe('fidelity: bound handler methods', () => {
  test('destructured handler methods work like the real client', async () => {
    // Real: the handlers bind their public API in the constructor
    // (record-handler.js:125-132, rpc-handler.js:15-17, event-handler.js:19-23).
    const { set, get, observe } = ds.record
    const { provide, make } = ds.rpc
    const { emit, subscribe } = ds.event

    set('test:record', { a: 1 })
    assert.deepEqual(await get('test:record'), { a: 1 })
    const values = []
    const sub = observe('test:record').subscribe((v) => values.push(v))
    assert.deepEqual(values, [{ a: 1 }])
    sub.unsubscribe()

    provide('fn', () => 'ok')
    assert.equal(await make('fn'), 'ok')

    const received = []
    subscribe('topic', (d) => received.push(d))
    emit('topic', 7)
    assert.deepEqual(received, [7])
  })
})
