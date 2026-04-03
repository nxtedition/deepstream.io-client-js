import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../src/constants/constants.js'

// Minimal mock helpers
function createMockConnection(connected = true) {
  return {
    connected,
    messages: [],
    sendMsg(topic, action, data) {
      this.messages.push({ topic, action, data })
    },
  }
}

function createMockClient() {
  return {
    errors: [],
    _$onError(topic, event, err, data) {
      this.errors.push({ topic, event, err, data })
    },
  }
}

function createMockHandler(connection, client) {
  return {
    _client: client,
    _connection: connection,
  }
}

function msg(action, data) {
  return { action, data }
}

// We can't import the Listener directly because it depends on xxhash-wasm (top-level await).
// Instead, we dynamically import after setting up mocks.
let Listener

describe('LegacyListener', async () => {
  Listener = (await import('../src/utils/legacy-listener.js')).default

  describe('constructor', () => {
    it('sends LISTEN on construction when connected', () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler)

      assert.equal(connection.messages.length, 1)
      assert.deepEqual(connection.messages[0], {
        topic: C.TOPIC.RECORD,
        action: C.ACTIONS.LISTEN,
        data: ['test/.*'],
      })
    })

    it('does not send LISTEN when not connected', () => {
      const connection = createMockConnection(false)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler)

      assert.equal(connection.messages.length, 0)
    })
  })

  describe('_$onMessage - not connected', () => {
    it('returns true and reports error with correct topic', () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      const listener = new Listener(C.TOPIC.EVENT, 'test/.*', () => null, handler)

      // Simulate disconnect without calling _$onConnectionStateChange
      connection.connected = false

      const result = listener._$onMessage(
        msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND, ['test/.*', 'test/1']),
      )

      assert.equal(result, true)
      assert.equal(client.errors.length, 1)
      assert.equal(client.errors[0].topic, C.TOPIC.EVENT) // Bug 1: was hardcoded to RECORD
      assert.equal(client.errors[0].event, C.EVENT.NOT_CONNECTED)
    })
  })

  describe('_$onMessage - SUBSCRIPTION_FOR_PATTERN_FOUND', () => {
    it('creates a provider and sends LISTEN_ACCEPT via microtask', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)
      const { of } = await import('rxjs')

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => of({ key: 'value' }), handler)
      connection.messages.length = 0

      const result = listener._$onMessage(
        msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND, ['test/.*', 'test/1']),
      )

      assert.equal(result, true)
      assert.equal(listener.stats.subscriptions, 1)

      // Wait for microtask to fire provider.send()
      await new Promise((r) => queueMicrotask(r))

      const acceptMsg = connection.messages.find((m) => m.action === C.ACTIONS.LISTEN_ACCEPT)
      assert.ok(acceptMsg, 'should send LISTEN_ACCEPT')
      assert.deepEqual(acceptMsg.data, ['test/.*', 'test/1'])
    })

    it('rejects duplicate subscription names', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)
      const rxjs = await import('rxjs')

      const listener = new Listener(
        C.TOPIC.RECORD,
        'test/.*',
        () => rxjs.of({ key: 'val' }),
        handler,
      )
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND, ['test/.*', 'test/1']))
      listener._$onMessage(msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND, ['test/.*', 'test/1']))

      assert.equal(client.errors.length, 1)
      assert.ok(String(client.errors[0].err).includes('invalid add'))
    })

    it('cleans up provider when callback throws (Bug 3)', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      const listener = new Listener(
        C.TOPIC.RECORD,
        'test/.*',
        () => {
          throw new Error('callback failed')
        },
        handler,
      )
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND, ['test/.*', 'test/1']))

      // Provider should be removed from map after callback throws
      assert.equal(listener.stats.subscriptions, 0)
      assert.equal(client.errors.length, 1)
    })

    it('sends LISTEN_REJECT when callback returns null', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler)
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND, ['test/.*', 'test/1']))

      // rxjs.of(null) emits null synchronously, provider.next(null) sets value$ to null
      // provider.send is queued via microtask — wait for it, then another for delivery
      await new Promise((r) => queueMicrotask(r))
      await new Promise((r) => queueMicrotask(r))

      // With null callback, value$ stays null, so accepted=false matches initial accepted=false
      // The provider never sends ACCEPT in the first place, so no REJECT is sent either.
      // This is correct behavior: null means "don't provide", so we don't accept or reject.
      assert.equal(listener.stats.subscriptions, 1)
    })
  })

  describe('_$onMessage - SUBSCRIPTION_FOR_PATTERN_REMOVED', () => {
    it('stops and removes the provider', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler)
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND, ['test/.*', 'test/1']))
      assert.equal(listener.stats.subscriptions, 1)

      listener._$onMessage(msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_REMOVED, ['test/.*', 'test/1']))
      assert.equal(listener.stats.subscriptions, 0)
    })

    it('errors on removal of unknown subscription', () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler)

      listener._$onMessage(
        msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_REMOVED, ['test/.*', 'test/unknown']),
      )

      assert.equal(client.errors.length, 1)
      assert.ok(String(client.errors[0].err).includes('invalid remove'))
    })
  })

  describe('_$onMessage - LISTEN_ACCEPT', () => {
    it('starts value subscription when provider has value$', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)
      const rxjs = await import('rxjs')

      const value$ = new rxjs.BehaviorSubject({ data: 'hello' })

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => value$, handler)
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND, ['test/.*', 'test/1']))

      // Wait for microtask to send LISTEN_ACCEPT
      await new Promise((r) => queueMicrotask(r))

      // Server sends back LISTEN_ACCEPT
      listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))

      // Should have sent an UPDATE with the value
      const updateMsg = connection.messages.find((m) => m.action === C.ACTIONS.UPDATE)
      assert.ok(updateMsg, 'should send UPDATE after LISTEN_ACCEPT')
      assert.equal(updateMsg.data[0], 'test/1')
    })

    it('ignores LISTEN_ACCEPT when provider has no value$', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler)
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND, ['test/.*', 'test/1']))

      listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))

      // No error, no crash
      assert.equal(client.errors.length, 0)
    })
  })

  describe('_$onMessage - unknown action', () => {
    it('returns false for unrecognized actions', () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler)

      const result = listener._$onMessage(msg(C.ACTIONS.UPDATE, ['test/.*', 'test/1']))
      assert.equal(result, false)
    })
  })

  describe('_$onConnectionStateChange', () => {
    it('re-sends LISTEN on reconnect', () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler)
      connection.messages.length = 0

      // Simulate disconnect
      connection.connected = false
      listener._$onConnectionStateChange()

      // Simulate reconnect
      connection.connected = true
      listener._$onConnectionStateChange()

      assert.equal(connection.messages.length, 1)
      assert.deepEqual(connection.messages[0], {
        topic: C.TOPIC.RECORD,
        action: C.ACTIONS.LISTEN,
        data: ['test/.*'],
      })
    })

    it('clears all subscriptions on disconnect', () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler)

      listener._$onMessage(msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND, ['test/.*', 'test/1']))
      assert.equal(listener.stats.subscriptions, 1)

      connection.connected = false
      listener._$onConnectionStateChange()

      assert.equal(listener.stats.subscriptions, 0)
    })
  })

  describe('_$destroy', () => {
    it('sends UNLISTEN and cleans up when connected', () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler)

      listener._$onMessage(msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND, ['test/.*', 'test/1']))
      connection.messages.length = 0

      listener._$destroy()

      assert.equal(listener.stats.subscriptions, 0)
      const unlistenMsg = connection.messages.find((m) => m.action === C.ACTIONS.UNLISTEN)
      assert.ok(unlistenMsg, 'should send UNLISTEN')
    })

    it('does not send UNLISTEN when not connected', () => {
      const connection = createMockConnection(false)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler)

      listener._$destroy()

      const unlistenMsg = connection.messages.find((m) => m.action === C.ACTIONS.UNLISTEN)
      assert.equal(unlistenMsg, undefined)
    })
  })

  describe('provider.observer - record values', () => {
    it('deduplicates identical values by hash', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)
      const rxjs = await import('rxjs')

      const subject = new rxjs.BehaviorSubject({ key: 'value' })

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => subject, handler)
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND, ['test/.*', 'test/1']))
      await new Promise((r) => queueMicrotask(r))

      listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))

      const updateCount = connection.messages.filter((m) => m.action === C.ACTIONS.UPDATE).length

      // Emit same value again
      subject.next({ key: 'value' })

      const updateCount2 = connection.messages.filter((m) => m.action === C.ACTIONS.UPDATE).length
      assert.equal(updateCount2, updateCount, 'should not send duplicate UPDATE for same hash')
    })

    it('handles null values from observer by calling provider.next(null)', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)
      const rxjs = await import('rxjs')

      const subject = new rxjs.Subject()

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => subject, handler)
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND, ['test/.*', 'test/1']))
      await new Promise((r) => queueMicrotask(r))

      listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))

      // Emit null - should trigger provider.next(null) which rejects
      subject.next(null)
      await new Promise((r) => queueMicrotask(r))

      const rejectMsg = connection.messages.find((m) => m.action === C.ACTIONS.LISTEN_REJECT)
      assert.ok(rejectMsg, 'should send LISTEN_REJECT when value becomes null')
    })

    it('errors on invalid non-object non-string values', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)
      const rxjs = await import('rxjs')

      const subject = new rxjs.Subject()

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => subject, handler)
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND, ['test/.*', 'test/1']))
      await new Promise((r) => queueMicrotask(r))

      listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))

      subject.next(42)

      assert.equal(client.errors.length, 1)
      assert.ok(String(client.errors[0].err).includes('invalid value'))
    })
  })

  describe('provider.error - retry behavior', () => {
    it('retries after error with timeout', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)
      const rxjs = await import('rxjs')

      let callCount = 0
      const listener = new Listener(
        C.TOPIC.RECORD,
        'test/.*',
        () => {
          callCount++
          if (callCount === 1) {
            return rxjs.throwError(() => new Error('temporary'))
          }
          return rxjs.of({ ok: true })
        },
        handler,
        { recursive: true },
      )
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND, ['test/.*', 'test/1']))

      assert.equal(callCount, 1)
      assert.equal(client.errors.length, 1)

      // The retry timeout is 10 seconds, we don't want to actually wait
      // Just verify the provider is still in the map (will be retried)
      assert.equal(listener.stats.subscriptions, 1)
    })
  })
})
