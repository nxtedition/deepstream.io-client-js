import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../src/constants/constants.js'

// Minimal mock helpers
function createMockConnection() {
  return {
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
let RpcHandler

describe('RpcHandler.provide', async () => {
  RpcHandler = (await import('../src/rpc/rpc-handler.js')).default

  function createHandler() {
    const connection = createMockConnection()
    const client = createMockClient()
    const handler = new RpcHandler({}, connection, client)
    return { handler, connection, client }
  }

  it('returns a disposer with Symbol.dispose pointing at itself and sends SUBSCRIBE', () => {
    const { handler, connection } = createHandler()

    const disposer = handler.provide('rpc/test', () => null)

    assert.equal(typeof disposer, 'function')
    assert.equal(disposer[Symbol.dispose], disposer)
    assert.deepEqual(connection.messages, [
      { topic: C.TOPIC.RPC, action: C.ACTIONS.SUBSCRIBE, data: ['rpc/test'] },
    ])
  })

  it('disposing removes the provider and sends UNSUBSCRIBE', () => {
    const { handler, connection } = createHandler()

    const disposer = handler.provide('rpc/test', () => null)
    assert.equal(handler.stats.listeners, 1)
    connection.messages.length = 0

    disposer()

    assert.equal(handler.stats.listeners, 0)
    assert.deepEqual(connection.messages, [
      { topic: C.TOPIC.RPC, action: C.ACTIONS.UNSUBSCRIBE, data: ['rpc/test'] },
    ])
  })

  it('disposing twice is a no-op and does not report NOT_PROVIDING', () => {
    const { handler, connection, client } = createHandler()

    const disposer = handler.provide('rpc/test', () => null)
    disposer()
    connection.messages.length = 0

    disposer()
    disposer[Symbol.dispose]()

    assert.equal(connection.messages.length, 0)
    assert.equal(client.errors.length, 0)
  })

  it('disposing after manual unprovide is a no-op', () => {
    const { handler, connection, client } = createHandler()

    const disposer = handler.provide('rpc/test', () => null)
    handler.unprovide('rpc/test')
    connection.messages.length = 0

    disposer()

    assert.equal(connection.messages.length, 0)
    assert.equal(client.errors.length, 0)
  })

  it('stale disposer does not remove a newer provider for the same name', () => {
    const { handler, connection } = createHandler()

    const disposer1 = handler.provide('rpc/test', () => null)
    disposer1()

    handler.provide('rpc/test', () => null)
    assert.equal(handler.stats.listeners, 1)
    connection.messages.length = 0

    disposer1()

    assert.equal(handler.stats.listeners, 1)
    assert.equal(connection.messages.length, 0)
  })

  it('duplicate provide returns undefined and reports PROVIDER_EXISTS', () => {
    const { handler, client } = createHandler()

    const disposer1 = handler.provide('rpc/test', () => null)
    const disposer2 = handler.provide('rpc/test', () => null)

    assert.equal(typeof disposer1, 'function')
    assert.equal(disposer2, undefined)
    assert.equal(client.errors.length, 1)
    assert.equal(client.errors[0].topic, C.TOPIC.RPC)
    assert.equal(client.errors[0].event, C.EVENT.PROVIDER_EXISTS)
    assert.equal(handler.stats.listeners, 1)
  })
})
