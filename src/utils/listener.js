const C = require('../constants/constants')
const xuid = require('xuid')
const { Observable } = require('rxjs')
const lz = require('../utils/lz')

const Listener = function (topic, pattern, callback, handler, recursive) {
  this._topic = topic
  this._pattern = pattern
  this._callback = callback
  this._handler = handler
  this._options = this._handler._options
  this._client = this._handler._client
  this._connection = this._handler._connection
  this._providers = new Map()
  this.recursive = recursive

  this._$handleConnectionStateChange()
}

Object.defineProperty(Listener.prototype, 'connected', {
  get: function connected () {
    return this._client.getConnectionState() === C.CONNECTION_STATE.OPEN
  }
})

Listener.prototype._$destroy = function () {
  if (this.connected) {
    this._connection.sendMsg(this._topic, C.ACTIONS.UNLISTEN, [this._pattern])
  }

  this._reset()
}

Listener.prototype._$onMessage = function (message) {
  const name = message.data[1]

  let provider = this._providers.get(name)

  if (message.action === C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND) {
    if (provider && provider.patternSubscription) {
      this._client._$onError(this._topic, C.EVENT.LISTENER_ERROR, 'listener exists', [this._pattern, name])
      return
    }

    provider = {
      name,
      value$: null,
      version: null,
      body: null,
      ready: false,
      disposed: false,
      patternSubscription: null,
      valueSubscription: null
    }
    provider.dispose = () => {
      if (provider.patternSubscription) {
        provider.patternSubscription.unsubscribe()
        provider.patternSubscription = null
      }
      if (provider.valueSubscription) {
        provider.valueSubscription.unsubscribe()
        provider.valueSubscription = null
      }
      provider.disposed = true
      this._providers.delete(provider.name)
    }
    provider.next = value$ => {
      if (!value$) {
        value$ = null
      } else if (!value$.subscribe) {
        // Compat for recursive with value
        value$ = Observable.of(value$)
      }

      if (Boolean(value$) !== Boolean(provider.value$)) {
        this._connection.sendMsg(this._topic, value$ ? C.ACTIONS.LISTEN_ACCEPT : C.ACTIONS.LISTEN_REJECT, [this._pattern, provider.name])
      }

      provider.value$ = value$
      if (provider.valueSubscription) {
        provider.valueSubscription.unsubscribe()
        provider.valueSubscription = value$ ? value$.subscribe(provider.observer) : null
      }
    }
    provider.error = err => {
      this._client._$onError(this._topic, C.EVENT.LISTENER_ERROR, err, [this._pattern, provider.name])

      if (provider.value$) {
        this._connection.sendMsg(this._topic, C.ACTIONS.LISTEN_REJECT, [this._pattern, provider.name])
        provider.value$ = null
      }

      provider.dispose()
    }
    provider.observer = {
      next: value => {
        if (!value) {
          provider.next(null)
          return
        }

        if (typeof value !== 'object') {
          const err = new Error('invalid value')
          this._client._$onError(this._topic, C.EVENT.USER_ERROR, err, [this._pattern, provider.name, value])
          return
        }

        if (this._topic === C.TOPIC.EVENT) {
          this._handler.emit(provider.name, value)
        } else if (this._topic === C.TOPIC.RECORD) {
          // TODO (perf): Check for equality before compression.
          lz.compress(JSON.stringify(value), (err, body) => {
            if (provider.disposed) {
              return
            }

            if (err) {
              this._client._$onError(this._topic, C.EVENT.LZ_ERROR, err, [this._pattern, provider.name, value])
              return
            }

            if (provider.body !== body || !/^INF-/.test(provider.version)) {
              provider.version = `INF-${xuid()}-${this._client.user || ''}`
              provider.body = body
              provider.ready = true
              this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.UPDATE, [provider.name, provider.version, provider.body])

              this._handler._$handle({
                action: C.ACTIONS.UPDATE,
                data: [provider.name, provider.version, value]
              })

              // TODO (perf): Let client handle its own has provider state instead of having the server
              // send on/off messages.
            } else if (!provider.ready) {
              provider.ready = true
              // TODO (perf): Sending body here should be unnecessary.
              this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.UPDATE, [provider.name, provider.version, provider.body])

              this._handler._$handle({
                action: C.ACTIONS.UPDATE,
                data: [provider.name, provider.version, value]
              })
            }
          })
        }
      },
      error: provider.error
    }

    let provider$
    try {
      provider$ = this._callback(name)
      if (!this.recursive) {
        provider$ = Observable.of(provider$)
      }
    } catch (err) {
      provider$ = Observable.throw(err)
    }

    this._providers.set(provider.name, provider)
    provider.patternSubscription = provider$.subscribe(provider)
  } else if (message.action === C.ACTIONS.LISTEN_ACCEPT) {
    if (provider && provider.valueSubscription) {
      this._client._$onError(this._topic, C.EVENT.LISTENER_ERROR, 'listener started', [this._pattern, name])
    } else if (!provider || !provider.value$) {
      this._connection.sendMsg(this._topic, C.ACTIONS.LISTEN_REJECT, [this._pattern, name])
    } else {
      provider.ready = false
      provider.version = message.data[2]
      provider.body = message.data[3]
      provider.valueSubscription = provider.value$.subscribe(provider.observer)
    }
  } else if (message.action === C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_REMOVED) {
    if (provider) {
      provider.dispose()
    }
  } else {
    return false
  }
  return true
}

Listener.prototype._$handleConnectionStateChange = function () {
  if (this.connected) {
    this._connection.sendMsg(this._topic, C.ACTIONS.LISTEN, [this._pattern])
  } else {
    this._reset()
  }
}

Listener.prototype._reset = function () {
  for (const provider of this._providers.values()) {
    provider.dispose()
  }
  this._providers.clear()
}

module.exports = Listener
