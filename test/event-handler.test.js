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

function createMockClient(state = C.CONNECTION_STATE.OPEN) {
  return {
    errors: [],
    on() {},
    getConnectionState() {
      return state
    },
    _$onError(topic, event, err, data) {
      this.errors.push({ topic, event, err, data })
    },
  }
}

// We can't import the handler directly because it depends on xxhash-wasm (top-level await).
// Instead, we dynamically import after setting up mocks.
let EventHandler

describe('EventHandler.provide', async () => {
  EventHandler = (await import('../src/event/event-handler.js')).default

  function createHandler() {
    const connection = createMockConnection(true)
    const client = createMockClient()
    const handler = new EventHandler({}, connection, client)
    return { handler, connection, client }
  }

  it('returns a disposer with Symbol.dispose pointing at itself', () => {
    const { handler } = createHandler()

    const disposer = handler.provide('test/.*', () => null, {})

    assert.equal(typeof disposer, 'function')
    assert.equal(disposer[Symbol.dispose], disposer)
  })

  it('registers a listener and disposing removes it and sends UNLISTEN', () => {
    const { handler, connection } = createHandler()

    const disposer = handler.provide('test/.*', () => null, {})
    assert.equal(handler.stats.listeners, 1)
    connection.messages.length = 0

    disposer()

    assert.equal(handler.stats.listeners, 0)
    assert.deepEqual(connection.messages, [
      { topic: C.TOPIC.EVENT, action: C.ACTIONS.UNLISTEN, data: ['test/.*'] },
    ])
  })

  it('disposing twice is a no-op', () => {
    const { handler, connection, client } = createHandler()

    const disposer = handler.provide('test/.*', () => null, {})
    disposer()
    connection.messages.length = 0

    disposer()
    disposer[Symbol.dispose]()

    assert.equal(connection.messages.length, 0)
    assert.equal(client.errors.length, 0)
  })

  it('stale disposer does not remove a newer listener for the same pattern', () => {
    const { handler, connection } = createHandler()

    const disposer1 = handler.provide('test/.*', () => null, {})
    disposer1()

    handler.provide('test/.*', () => null, {})
    assert.equal(handler.stats.listeners, 1)
    connection.messages.length = 0

    disposer1()

    assert.equal(handler.stats.listeners, 1)
    assert.equal(connection.messages.length, 0)
  })

  it('duplicate provide returns undefined and reports LISTENER_EXISTS', () => {
    const { handler, client } = createHandler()

    const disposer1 = handler.provide('test/.*', () => null, {})
    const disposer2 = handler.provide('test/.*', () => null, {})

    assert.equal(typeof disposer1, 'function')
    assert.equal(disposer2, undefined)
    assert.equal(client.errors.length, 1)
    assert.equal(client.errors[0].topic, C.TOPIC.EVENT)
    assert.equal(client.errors[0].event, C.EVENT.LISTENER_EXISTS)
    assert.equal(handler.stats.listeners, 1)
  })

  it('unicast listener disposer behaves the same', () => {
    const { handler, connection } = createHandler()

    const disposer = handler.provide('test/.*', () => null, { mode: 'unicast' })
    assert.equal(disposer[Symbol.dispose], disposer)
    connection.messages.length = 0

    disposer()
    disposer()

    assert.equal(handler.stats.listeners, 0)
    assert.deepEqual(connection.messages, [
      { topic: C.TOPIC.EVENT, action: C.ACTIONS.UNLISTEN, data: ['test/.*'] },
    ])
  })
})
