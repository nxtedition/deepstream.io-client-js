import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as rxjs from 'rxjs'
import { MockDeepstreamClient, parseJsonRecordName, jsonProvider } from '../src/mock/index.ts'

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
let controller
let settle

beforeEach(async () => {
  const mock = MockDeepstreamClient.create()
  ds = mock.client
  controller = mock.controller
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
  test('fresh record reaches SERVER with empty data after the server read', async () => {
    const record = ds.record.getRecord('test:record')
    assert.equal(record.state, ds.record.VOID) // async: VOID until the read reply
    await record.when(ds.record.SERVER)
    assert.equal(record.state, ds.record.SERVER)
    assert.deepEqual(record.data, {})
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

  test('stats.created counts created records', () => {
    ds.record.getRecord('test:a')
    ds.record.getRecord('test:a')
    ds.record.getRecord('test:b')
    assert.equal(ds.record.stats.created, 2)
  })

  // dropped: old tests counted observe()/record.subscribe() into
  // stats.subscriptions. The real handler's stats.subscriptions counts
  // provider-side subscriptions, not client observes (record-handler.js
  // stats getter), so those assertions no longer apply.
})

// ---------------------------------------------------------------------------
// RecordHandler — cleanup (controller)
// ---------------------------------------------------------------------------
describe('RecordHandler cleanup', () => {
  test('clears all records', async () => {
    ds.record.set('test:a', { v: 1 })
    ds.record.set('test:b', { v: 2 })
    await settle()
    controller.cleanup()
    await settle()
    assert.equal(ds.record.stats.records, 0)
  })

  test('clears all providers', async () => {
    ds.record.provide('test:.*', () => ({ provided: true }))
    await settle()
    controller.cleanup()
    await settle()
    const record = ds.record.getRecord('test:something')
    await record.when(ds.record.SERVER)
    assert.equal(record.state, ds.record.SERVER) // no provider after cleanup
  })

  test('cancels active provider subscriptions without throwing', async () => {
    const subject = new rxjs.Subject()
    ds.record.provide('test:record', () => subject)
    ds.record.getRecord('test:record')
    await settle()
    controller.cleanup()
    await settle()
    assert.doesNotThrow(() => subject.next({ after: 'cleanup' }))
  })
})

// ---------------------------------------------------------------------------
// MockRecord — version
// ---------------------------------------------------------------------------
describe('MockRecord version', () => {
  test('unwritten reads carry the empty version, client writes bump it', async () => {
    const record = ds.record.getRecord('test:record')
    await record.when(ds.record.SERVER)
    assert.equal(record.version, '0-00000000000000')
    ds.record.set('test:record', { a: 1 })
    await settle()
    assert.match(record.version, /^1-/)
    ds.record.set('test:record', { a: 2 })
    await settle()
    assert.match(record.version, /^2-/)
  })
})

// ---------------------------------------------------------------------------
// MockRecord — subscribe / unsubscribe
// ---------------------------------------------------------------------------
describe('MockRecord subscribe/unsubscribe', () => {
  test('subscription is removed from the map after unsubscribe', () => {
    const record = ds.record.getRecord('test:record')
    const cb = () => {}
    record.subscribe(cb)
    assert.ok(controller.getRecordSubscriptions('test:record').some(([c]) => c === cb))
    record.unsubscribe(cb)
    assert.ok(!controller.getRecordSubscriptions('test:record').some(([c]) => c === cb))
  })
})

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------
describe('MockRpcHandler', () => {
  test('cleanup() removes all providers', async () => {
    ds.rpc.provide('a', () => 1)
    ds.rpc.provide('b', () => 2)
    await settle()
    controller.cleanup()
    await settle()
    await assert.rejects(ds.rpc.make('a'))
    await assert.rejects(ds.rpc.make('b'))
  })
})

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
describe('MockEventHandler', () => {
  test('cleanup() removes all subscriptions', async () => {
    const received = []
    ds.event.subscribe('topic', (d) => received.push(d))
    controller.cleanup()
    await settle()
    ds.event.emit('topic', 'ignored')
    assert.equal(received.length, 0)
  })
})

// ---------------------------------------------------------------------------
// MockDeepstreamClient — utility methods
// ---------------------------------------------------------------------------
describe('MockDeepstreamClient', () => {
  test('getConnectionState() returns OPEN once connected', () => {
    assert.equal(ds.getConnectionState(), 'OPEN')
  })
})

// ---------------------------------------------------------------------------
// Controller — setRecordState
// ---------------------------------------------------------------------------
describe('controller.setRecordState', () => {
  test('drives a record to SERVER with data', async () => {
    const record = ds.record.getRecord('test:record')
    controller.setRecordState('test:record', ds.record.SERVER, { v: 1 })
    await settle()
    assert.equal(record.state, ds.record.SERVER)
    assert.deepEqual(record.data, { v: 1 })
  })

  test('drives a record to PROVIDER with data', async () => {
    const record = ds.record.getRecord('test:record')
    controller.setRecordState('test:record', ds.record.PROVIDER, { v: 1 })
    await settle()
    assert.equal(record.state, ds.record.PROVIDER)
    assert.deepEqual(record.data, { v: 1 })
  })

  test('drives a record to STALE preserving data', async () => {
    const record = ds.record.getRecord('test:record')
    controller.setRecordState('test:record', ds.record.STALE, { v: 1 })
    await settle()
    assert.equal(record.state, ds.record.STALE)
    assert.deepEqual(record.data, { v: 1 })
  })

  test('setRecordState(CLIENT) throws — CLIENT is connection-scoped', () => {
    assert.throws(
      () => controller.setRecordState('test:record', ds.record.CLIENT),
      /dropConnection/,
    )
  })
})

// ---------------------------------------------------------------------------
// parseJsonRecordName
// ---------------------------------------------------------------------------
describe('parseJsonRecordName', () => {
  test('parses a valid JSON record name', () => {
    assert.deepEqual(parseJsonRecordName('{"type":"asset","id":"abc"}:permission'), {
      json: { type: 'asset', id: 'abc' },
      suffix: ':permission',
    })
  })

  test('parses a name with a query-style suffix', () => {
    assert.deepEqual(parseJsonRecordName('{"query":"foo"}:search?'), {
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
    assert.deepEqual(await ds.record.get('{"type":"asset"}:permission', ds.record.PROVIDER), {
      canEdit: true,
    })
  })

  test('returns null (skips) when the matcher returns null', async () => {
    ds.record.provide(
      ...jsonProvider(':permission', ({ type }) => (type === 'user' ? { canEdit: true } : null)),
    )
    const record = ds.record.getRecord('{"type":"asset"}:permission')
    await record.when(ds.record.SERVER)
    assert.equal(record.state, ds.record.SERVER) // matcher returned null → no provider
  })

  test('does not match a plain record name without JSON', async () => {
    const calls = []
    ds.record.provide(
      ...jsonProvider(':permission', (json) => {
        calls.push(JSON.stringify(json))
        return { provided: true }
      }),
    )
    const record = ds.record.getRecord('asset:permission') // plain name, no JSON
    await record.when(ds.record.SERVER)
    assert.equal(calls.length, 0)
  })

  test('pattern is anchored to the suffix', async () => {
    ds.record.provide(...jsonProvider(':search?', ({ query }) => ({ results: [query] })))
    assert.deepEqual(await ds.record.get('{"query":"foo"}:search?', ds.record.PROVIDER), {
      results: ['foo'],
    })
    const other = ds.record.getRecord('{"query":"foo"}:other')
    await other.when(ds.record.SERVER)
    assert.equal(other.state, ds.record.SERVER) // different suffix → no provider
  })

  test('spreads cleanly into ds.record.provide()', async () => {
    const tuple = jsonProvider(':perm', () => ({ ok: true }))
    assert.equal(tuple.length, 2)
    assert.equal(typeof tuple[0], 'string') // pattern
    assert.equal(typeof tuple[1], 'function') // callback
    ds.record.provide(...tuple)
    assert.deepEqual(await ds.record.get('{"x":1}:perm', ds.record.PROVIDER), { ok: true })
  })
})

describe('MockEventHandler connected / stats', () => {
  test('connected is true once the connection is open', () => {
    assert.equal(ds.event.connected, true)
  })
})

describe('fidelity: getRecord & put validation', () => {
  test('valid put applies version and data', async () => {
    ds.record.put('test:record', '5-abc', { a: 1 })
    const record = ds.record.getRecord('test:record')
    await record.when(ds.record.SERVER)
    assert.equal(record.version, '5-abc')
    assert.deepEqual(record.data, { a: 1 })
  })
})
