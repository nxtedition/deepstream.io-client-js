const C = require('./constants/constants')
const Emitter = require('component-emitter2')
const Connection = require('./message/connection')
const EventHandler = require('./event/event-handler')
const RpcHandler = require('./rpc/rpc-handler')
const RecordHandler = require('./record/record-handler')
const defaultOptions = require('./default-options')
const xuid = require('xuid')
const utils = require('./utils/utils')

const Client = function (url, options) {
  this._url = url
  this._options = this._getOptions(options || {})

  this._connection = new Connection(this, this._url, this._options)

  this.nuid = xuid
  this.event = new EventHandler(this._options, this._connection, this)
  this.rpc = new RpcHandler(this._options, this._connection, this)
  this.record = new RecordHandler(this._options, this._connection, this)

  this._messageCallbacks = {}
  this._messageCallbacks[C.TOPIC.EVENT] = this.event._$handle.bind(this.event)
  this._messageCallbacks[C.TOPIC.RPC] = this.rpc._$handle.bind(this.rpc)
  this._messageCallbacks[C.TOPIC.RECORD] = this.record._$handle.bind(this.record)
  this._messageCallbacks[C.TOPIC.ERROR] = this._onErrorMessage.bind(this)
}

Emitter(Client.prototype)

Client.prototype.login = function (authParamsOrCallback, callback) {
  if (typeof authParamsOrCallback === 'function') {
    this._connection.authenticate({}, authParamsOrCallback)
  } else {
    this._connection.authenticate(authParamsOrCallback || {}, callback)
  }
  return this
}

Client.prototype.close = function () {
  this._connection.close()
}

Client.prototype.getConnectionState = function () {
  return this._connection.getState()
}

Client.prototype.getUid = function () {
  const timestamp = (new Date()).getTime().toString(36)
  const randomString = (Math.random() * 10000000000000000).toString(36).replace('.', '')

  return `${timestamp}-${randomString}`
}

Client.prototype._$onMessage = function (message) {
  if (this._messageCallbacks[message.topic]) {
    this._messageCallbacks[message.topic](message)
  } else {
    message.processedError = true
    this._$onError(
      message.topic,
      C.EVENT.MESSAGE_PARSE_ERROR,
      `Received message for unknown topic ${message.topic}`
    )
  }

  if (message.action === C.ACTIONS.ERROR && !message.processedError) {
    this._$onError(message.topic, message.data[0], message.data.slice(0))
  }
}

Client.prototype._$onError = function (topic, event, msg) {
  let errorMsg

  const error = msg && msg.message ? msg : new Error(msg)
  error.topic = topic
  error.event = event

  if (this.hasListeners('error')) {
    this.emit('error', error)
    this.emit(event, error)
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

function createDeepstream (url, options) {
  return new Client(url, options)
}

Client.prototype.isSameOrNewer = utils.isSameOrNewer
Client.prototype.CONSTANTS = C
createDeepstream.CONSTANTS = C

module.exports = createDeepstream
