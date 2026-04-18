import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../src/constants/constants.js'

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

let Listener

describe('UnicastListener', async () => {
  Listener = (await import('../src/utils/unicast-listener.js')).default

  describe('constructor', () => {
    it('sends LISTEN with U flag on construction', () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler, {})

      assert.equal(connection.messages.length, 1)
      assert.deepEqual(connection.messages[0], {
        topic: C.TOPIC.RECORD,
        action: C.ACTIONS.LISTEN,
        data: ['test/.*', 'U'],
      })
    })

    it('throws on recursive option', () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      assert.throws(
        () => new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler, { recursive: true }),
        /invalid argument: recursive/,
      )
    })

    it('throws on stringify option', () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      assert.throws(
        () =>
          new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler, {
            stringify: JSON.stringify,
          }),
        /invalid argument: stringify/,
      )
    })
  })

  describe('_$onMessage - LISTEN_ACCEPT', () => {
    it('calls callback and subscribes when value$ returned', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)
      const rxjs = await import('rxjs')

      const value$ = new rxjs.BehaviorSubject('{"key":"value"}')

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => value$, handler, {})
      connection.messages.length = 0

      const result = listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))

      assert.equal(result, true)
      assert.equal(listener.stats.subscriptions, 1)

      const updateMsg = connection.messages.find((m) => m.action === C.ACTIONS.UPDATE)
      assert.ok(updateMsg, 'should send UPDATE')
      assert.equal(updateMsg.data[0], 'test/1')
    })

    it('sends LISTEN_REJECT when callback returns falsy', () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler, {})
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))

      assert.equal(listener.stats.subscriptions, 0)
      const rejectMsg = connection.messages.find((m) => m.action === C.ACTIONS.LISTEN_REJECT)
      assert.ok(rejectMsg, 'should send LISTEN_REJECT')
    })

    it('wraps callback exceptions in throwError and rejects', async () => {
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
        {},
      )
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))

      // The error is caught and wrapped in rxjs.throwError, which triggers the PIPE error,
      // which triggers the subscription error handler that sends LISTEN_REJECT
      assert.equal(client.errors.length, 1)
      const rejectMsg = connection.messages.find((m) => m.action === C.ACTIONS.LISTEN_REJECT)
      assert.ok(rejectMsg, 'should send LISTEN_REJECT on error')
      // subscription is removed by the error handler
      assert.equal(listener.stats.subscriptions, 0)
    })

    it('rejects duplicate subscription names', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)
      const rxjs = await import('rxjs')

      const listener = new Listener(
        C.TOPIC.RECORD,
        'test/.*',
        () => new rxjs.BehaviorSubject('{"x":1}'),
        handler,
        {},
      )
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))
      listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))

      assert.equal(client.errors.length, 1)
      assert.ok(String(client.errors[0].err).includes('invalid accept'))
    })
  })

  describe('_$onMessage - LISTEN_REJECT', () => {
    it('unsubscribes and removes provider', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)
      const rxjs = await import('rxjs')

      const value$ = new rxjs.BehaviorSubject('{"key":"value"}')

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => value$, handler, {})
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))
      assert.equal(listener.stats.subscriptions, 1)

      listener._$onMessage(msg(C.ACTIONS.LISTEN_REJECT, ['test/.*', 'test/1']))
      assert.equal(listener.stats.subscriptions, 0)
    })

    it('silently ignores removal of unknown subscription', () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler, {})

      const result = listener._$onMessage(msg(C.ACTIONS.LISTEN_REJECT, ['test/.*', 'test/unknown']))

      assert.equal(result, true)
      assert.equal(client.errors.length, 0)
    })
  })

  describe('_$onMessage - unknown action', () => {
    it('returns false for unrecognized actions', () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler, {})

      const result = listener._$onMessage(msg(C.ACTIONS.UPDATE, ['test/.*', 'test/1']))
      assert.equal(result, false)
    })
  })

  describe('_$onConnectionStateChange', () => {
    it('re-sends LISTEN on reconnect', () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => null, handler, {})
      connection.messages.length = 0

      listener._$onConnectionStateChange(false)
      listener._$onConnectionStateChange(true)

      assert.equal(connection.messages.length, 1)
      assert.deepEqual(connection.messages[0], {
        topic: C.TOPIC.RECORD,
        action: C.ACTIONS.LISTEN,
        data: ['test/.*', 'U'],
      })
    })

    it('clears subscriptions on disconnect without sending UNLISTEN (Bug 5 fix)', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)
      const rxjs = await import('rxjs')

      const listener = new Listener(
        C.TOPIC.RECORD,
        'test/.*',
        () => new rxjs.BehaviorSubject('{"x":1}'),
        handler,
        {},
      )
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))
      assert.equal(listener.stats.subscriptions, 1)

      connection.messages.length = 0
      listener._$onConnectionStateChange(false)

      assert.equal(listener.stats.subscriptions, 0)
      // Should NOT send UNLISTEN on disconnected connection
      const unlistenMsg = connection.messages.find((m) => m.action === C.ACTIONS.UNLISTEN)
      assert.equal(unlistenMsg, undefined, 'should not send UNLISTEN when disconnected')
    })
  })

  describe('_$destroy', () => {
    it('sends UNLISTEN and cleans up', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)
      const rxjs = await import('rxjs')

      const listener = new Listener(
        C.TOPIC.RECORD,
        'test/.*',
        () => new rxjs.BehaviorSubject('{"x":1}'),
        handler,
        {},
      )
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))
      connection.messages.length = 0

      listener._$destroy()

      assert.equal(listener.stats.subscriptions, 0)
      const unlistenMsg = connection.messages.find((m) => m.action === C.ACTIONS.UNLISTEN)
      assert.ok(unlistenMsg, 'should send UNLISTEN on destroy')
    })
  })

  describe('PIPE - value validation', () => {
    it('rejects non-JSON strings', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)
      const rxjs = await import('rxjs')

      const subject = new rxjs.BehaviorSubject('not-json')

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => subject, handler, {})
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))

      // Error should have been reported
      assert.equal(client.errors.length, 1)
    })

    it('accepts valid JSON strings', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)
      const rxjs = await import('rxjs')

      const subject = new rxjs.BehaviorSubject('{"valid": true}')

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => subject, handler, {})
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))

      assert.equal(client.errors.length, 0)
      const updateMsg = connection.messages.find((m) => m.action === C.ACTIONS.UPDATE)
      assert.ok(updateMsg)
    })

    it('serializes objects to JSON', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)
      const rxjs = await import('rxjs')

      const subject = new rxjs.BehaviorSubject({ key: 'value' })

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => subject, handler, {})
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))

      const updateMsg = connection.messages.find((m) => m.action === C.ACTIONS.UPDATE)
      assert.ok(updateMsg)
      assert.equal(updateMsg.data[2], '{"key":"value"}')
    })

    it('deduplicates identical serialized values', async () => {
      const connection = createMockConnection(true)
      const client = createMockClient()
      const handler = createMockHandler(connection, client)
      const rxjs = await import('rxjs')

      const subject = new rxjs.BehaviorSubject({ key: 'value' })

      const listener = new Listener(C.TOPIC.RECORD, 'test/.*', () => subject, handler, {})
      connection.messages.length = 0

      listener._$onMessage(msg(C.ACTIONS.LISTEN_ACCEPT, ['test/.*', 'test/1']))

      const count1 = connection.messages.filter((m) => m.action === C.ACTIONS.UPDATE).length

      // Same value, different object reference
      subject.next({ key: 'value' })

      const count2 = connection.messages.filter((m) => m.action === C.ACTIONS.UPDATE).length
      assert.equal(count2, count1, 'should deduplicate identical serialized values')
    })
  })
})
