const C = require('../constants/constants')
const rx = require('rxjs/operators')
const rxjs = require('rxjs')

class Listener {
  constructor(topic, pattern, callback, handler, { stringify = null, recursive = false } = {}) {
    this._topic = topic
    this._pattern = pattern
    this._callback = callback
    this._handler = handler
    this._client = this._handler._client
    this._connection = this._handler._connection
    this._connected = false
    this._subscriptions = new Map()
    this._stringify = stringify || JSON.stringify
    this._recursive = recursive

    this._pipe = rxjs.pipe(
      rx.map((value) => {
        let data
        if (value && typeof value === 'string') {
          if (value.charAt(0) !== '{' && value.charAt(0) !== '[') {
            throw new Error(`invalid value: ${value}`)
          }
          data = value
        } else if (value && typeof value === 'object') {
          data = this._stringify(value)
        } else {
          throw new Error(`invalid value: ${value}`)
        }

        return data
      }),
      rx.distinctUntilChanged()
    )

    this._$onConnectionStateChange()

    if (recursive) {
      throw new Error('invalid argument: recursive')
    }
  }

  get stats() {
    return {
      subscriptions: this._subscriptions.size,
    }
  }

  _$destroy() {
    this._reset()

    if (this._connected) {
      this._connection.sendMsg(this._topic, C.ACTIONS.UNLISTEN, [this._pattern])
    }
  }

  _$onMessage(message) {
    if (!this._connected) {
      this._client._$onError(
        C.TOPIC.RECORD,
        C.EVENT.NOT_CONNECTED,
        new Error('received message while not connected'),
        message
      )
      return
    }

    const name = message.data[1]

    if (message.action === C.ACTIONS.LISTEN_ACCEPT) {
      if (this._subscriptions.has(name)) {
        this._error(name, 'invalid accept: listener exists')
        return
      }

      const provider = this._subscriptions.get(name) ?? {
        outerSubscription: null,
        innerSubscription: null,
        data$: null,
        accepted: false,
        accept: () => {
          provider.innerSubscription = provider.data$.pipe(this._pipe).subscribe({
            next: (data) => {
              const version = `INF-${this._connection.hasher.h64ToString(data)}`
              this._connection.sendMsg(this._topic, C.ACTIONS.UPDATE, [name, version, data])
            },
            error: (err) => {
              this._error(name, err)
              this._connection.sendMsg(this._topic, C.ACTIONS.LISTEN_REJECT, [this._pattern, name])
            },
          })
        },
      }

      provider.accepted = true

      if (!provider.outerSubscription) {
        let value$
        try {
          value$ = this._callback(name)
        } catch (err) {
          value$ = rxjs.throwError(() => err)
        }

        if (!this._recursive) {
          value$ = rxjs.of(value$)
        }

        provider.outerSubscription = value$.subscribe({
          next: (data$) => {
            if (provider.innerSubscription) {
              provider.innerSubscription.unsubscribe()
              provider.innerSubscription = null
            }

            if (data$ == null) {
              if (provider.accepted) {
                provider.accepted = false
                this._connection.sendMsg(this._topic, C.ACTIONS.LISTEN_REJECT, [
                  this._pattern,
                  name,
                ])
              }
            } else {
              if (provider.accepted) {
                provider.accept()
              }
            }
          },
          error: (err) => {
            this._error(name, err)
            this._connection.sendMsg(this._topic, C.ACTIONS.LISTEN_REJECT, [this._pattern, name])
          },
        })
      } else if (!provider.innerSubscription) {
        provider.accept()
      }

      this._subscriptions.set(name, provider)
    } else if (message.action === C.ACTIONS.LISTEN_REJECT) {
      if (!this._subscriptions.has(name)) {
        this._error(name, 'invalid remove: listener missing')
        return
      }

      const subscription = this._subscriptions.get(name)

      subscription?.unsubscribe()

      this._subscriptions.delete(name)
    } else {
      return false
    }
    return true
  }

  _$onConnectionStateChange(connected) {
    this._connected = connected

    if (connected) {
      this._connection.sendMsg(this._topic, C.ACTIONS.LISTEN, [this._pattern, 'U'])
    } else {
      this._reset()
    }
  }

  _error(name, err) {
    this._client._$onError(this._topic, C.EVENT.LISTENER_ERROR, err, [this._pattern, name])
  }

  _reset() {
    for (const subscription of this._subscriptions.values()) {
      subscription?.unsubscribe()
    }
    this._subscriptions.clear()
  }
}

module.exports = Listener
