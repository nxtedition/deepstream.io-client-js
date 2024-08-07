import * as C from './constants/constants.js'
import Emitter from 'component-emitter2'
import Connection from './message/connection.js'
import EventHandler from './event/event-handler.js'
import RpcHandler from './rpc/rpc-handler.js'
import RecordHandler from './record/record-handler.js'
import defaultOptions from './default-options.js'
import xuid from 'xuid'
import * as utils from './utils/utils.js'

const Client = function (url, options) {
  this._url = url
  this._options = this._getOptions(options || {})

  this._connection = new Connection(this, this._url, this._options)
    .on('recv', (message) => {
      this.emit('recv', message)
    })
    .on('send', (message) => {
      this.emit('send', message)
    })

  this.nuid = xuid
  this.event = new EventHandler(this._options, this._connection, this)
  this.rpc = new RpcHandler(this._options, this._connection, this)
  this.record = new RecordHandler(this._options, this._connection, this)
  this.user = null

  this._messageCallbacks = {}
  this._messageCallbacks[C.TOPIC.EVENT] = this.event._$handle.bind(this.event)
  this._messageCallbacks[C.TOPIC.RPC] = this.rpc._$handle.bind(this.rpc)
  this._messageCallbacks[C.TOPIC.RECORD] = this.record._$handle.bind(this.record)
  this._messageCallbacks[C.TOPIC.ERROR] = this._onErrorMessage.bind(this)
}

Emitter(Client.prototype)

Object.defineProperty(Client.prototype, 'stats', {
  get: function stats() {
    return {
      record: this.record.stats,
      rpc: this.rpc.stats,
      event: this.event.stats,
    }
  },
})

Client.prototype.login = function (authParamsOrCallback, callback) {
  if (typeof authParamsOrCallback === 'function') {
    this._connection.authenticate({}, (success, authData) => {
      this.user = authData ? authData.id : null
      authParamsOrCallback(success, authData)
    })
  } else {
    this._connection.authenticate(authParamsOrCallback || {}, (success, authData) => {
      this.user = authData ? authData.id : null
      callback(success, authData)
    })
  }

  return this
}

Client.prototype.close = function () {
  this._connection.close()
}

Client.prototype.getConnectionState = function () {
  return this._connection.getState()
}

Client.prototype._$onMessage = function (message) {
  if (this._messageCallbacks[message.topic]) {
    try {
      this._messageCallbacks[message.topic](message)
    } catch (err) {
      this._$onError(message.topic, null, err, message.data.slice(0))
    }
  } else {
    message.processedError = true
    this._$onError(
      message.topic,
      C.EVENT.MESSAGE_PARSE_ERROR,
      `Received message for unknown topic ${message.topic}`,
    )
  }

  if (message.action === C.ACTIONS.ERROR && !message.processedError) {
    this._$onError(message.topic, message.data[0], message.data.slice(0))
  }
}

Client.prototype._$onError = function (topic, event, msgOrError, data) {
  const error =
    msgOrError && msgOrError.message ? msgOrError : new Error(msgOrError || 'unknown error')
  error.topic = topic
  error.event = event
  error.data = data

  if (this.hasListeners('error')) {
    this.emit('error', error)
    if (event) {
      this.emit(event, error)
    }
  } else {
    console.log('--- You can catch all deepstream errors by subscribing to the error event ---')

    throw error
  }
}

Client.prototype._onErrorMessage = function (errorMessage) {
  this._$onError(errorMessage.topic, errorMessage.data[0], errorMessage.data[1])
}

Client.prototype._getOptions = function (options) {
  const mergedOptions = {}

  for (const key in defaultOptions) {
    if (typeof options[key] === 'undefined') {
      mergedOptions[key] = defaultOptions[key]
    } else {
      mergedOptions[key] = options[key]
    }
  }

  return mergedOptions
}

export default function createDeepstream(url, options) {
  return new Client(url, options)
}

Client.prototype.isSameOrNewer = utils.isSameOrNewer
Client.prototype.CONSTANTS = C
createDeepstream.CONSTANTS = C
