import * as rxjs from 'rxjs'
import * as C from '../constants/constants.js'
import { h64, h64ToString } from '../utils/utils.js'

const valuePipe = rxjs.pipe(
  rxjs.map((value) => {
    let data
    if (value && typeof value === 'string') {
      if (value.charAt(0) !== '{' && value.charAt(0) !== '[') {
        throw new Error(`invalid value: ${value}`)
      }
      data = value
    } else if (value && typeof value === 'object') {
      data = JSON.stringify(value)
    } else if (data != null) {
      throw new Error(`invalid value: ${value}`)
    }

    return data
  }),
  rxjs.distinctUntilChanged(),
)

export default class Listener {
  constructor(topic, pattern, callback, handler, opts) {
    if (opts.recursive) {
      throw new Error('invalid argument: recursive')
    }
    if (opts.stringify) {
      throw new Error('invalid argument: stringify')
    }

    this._topic = topic
    this._pattern = pattern
    this._callback = callback
    this._handler = handler
    this._client = this._handler._client
    this._connection = this._handler._connection
    this._listening = false
    this._subscriptions = new Map()

    this._connection.sendMsg(this._topic, C.ACTIONS.LISTEN, [this._pattern, 'U'])
  }

  get stats() {
    return {
      subscriptions: this._subscriptions.size,
    }
  }

  _$destroy() {
    this._reset()
  }

  _$onMessage(message) {
    const name = message.data[1]

    // TODO (fix): Validate name

    const key = h64(name)

    if (message.action === C.ACTIONS.LISTEN_ACCEPT) {
      if (this._subscriptions.has(key)) {
        this._error(name, 'invalid accept: listener exists')
        return
      }

      let value$
      try {
        value$ = this._callback(name)
      } catch (err) {
        value$ = rxjs.throwError(() => err)
      }

      if (value$) {
        const subscription = value$.pipe(valuePipe).subscribe({
          next: (data) => {
            if (data == null) {
              this._connection.sendMsg(this._topic, C.ACTIONS.LISTEN_REJECT, [this._pattern, key])
              this._subscriptions.delete(key)
              subscription.unsubscribe()
            } else {
              const version = `INF-${h64ToString(data)}`
              this._connection.sendMsg(this._topic, C.ACTIONS.UPDATE, [key, version, data])
            }
          },
          error: (err) => {
            this._error(name, err)
            this._connection.sendMsg(this._topic, C.ACTIONS.LISTEN_REJECT, [this._pattern, key])
            this._subscriptions.delete(key)
          },
        })
        this._subscriptions.set(key, subscription)
      } else {
        this._connection.sendMsg(this._topic, C.ACTIONS.LISTEN_REJECT, [this._pattern, key])
      }
    } else if (message.action === C.ACTIONS.LISTEN_REJECT) {
      const subscription = this._subscriptions.get(key)

      if (subscription) {
        this._subscriptions.delete(key)
        subscription.unsubscribe()
      } else {
        this._error(name, 'invalid remove: listener missing')
      }
    } else {
      return false
    }
    return true
  }

  _$onConnectionStateChange(connected) {
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
      subscription.unsubscribe()
    }
    this._subscriptions.clear()

    this._connection.sendMsg(this._topic, C.ACTIONS.UNLISTEN, [this._pattern])
  }
}
