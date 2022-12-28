const jsonPath = require('./json-path')
const utils = require('../utils/utils')
const EventEmitter = require('component-emitter2')
const C = require('../constants/constants')
const messageParser = require('../message/message-parser')
const xuid = require('xuid')
const invariant = require('invariant')

const EMPTY_ENTRY = utils.deepFreeze([null, null, null])

const Record = function (name, handler) {
  this._handler = handler
  this._prune = handler._prune
  this._pendingWrite = handler._pendingWrite
  this._client = handler._client
  this._connection = handler._connection
  this._updates = null

  this._name = name
  this._provided = false
  this._entry = EMPTY_ENTRY
  this._patchQueue = []
  this._patchData = null
  this._usages = 0
}

Record.STATE = C.RECORD_STATE

EventEmitter(Record.prototype)

Record.prototype._$destroy = function () {
  invariant(this._usages === 0, this.name + ' must have no refs')
  invariant(this.version, this.name + ' must have version to destroy')
  invariant(this.isReady, this.name + ' must be ready to destroy')
  invariant(this._patchQueue == null, this.name + ' must not have patch queue')

  if (this.connected && this._usages) {
    this._connection.sendMsg1(C.TOPIC.RECORD, C.ACTIONS.UNSUBSCRIBE, this.name)
  }

  this._provided = false
  this._patchQueue = this._patchQueue || []

  return this
}

Object.defineProperty(Record.prototype, 'name', {
  enumerable: true,
  get: function name() {
    return this._name
  },
})

// TODO (perf): This is slow...
Object.defineProperty(Record.prototype, 'version', {
  enumerable: true,
  get: function version() {
    const version = this._entry[0]

    if (!this._patchQueue || !this._patchQueue.length) {
      return version
    }

    if (version && version.charAt(0) === 'I') {
      return version
    }

    const start = version ? parseInt(version) : 0
    return this._makeVersion(start + this._patchQueue.length)
  },
})

// TODO (perf): This is slow...
Object.defineProperty(Record.prototype, 'data', {
  enumerable: true,
  get: function data() {
    let data = this._entry[1] || jsonPath.EMPTY

    if (!this._patchQueue || !this._patchQueue.length) {
      return data
    }

    for (let i = 0; i < this._patchQueue.length; i += 2) {
      data = jsonPath.set(data, this._patchQueue[i + 0], this._patchQueue[i + 1], true)
    }

    // TODO (perf): This is slow...
    if (JSON.stringify(data) !== JSON.stringify(this._patchData)) {
      this._patchData = data
    }

    return this._patchData
  },
})

Object.defineProperty(Record.prototype, 'state', {
  enumerable: true,
  get: function state() {
    if (!this.version) {
      return Record.STATE.VOID
    }

    if (this._patchQueue) {
      return this.version.charAt(0) === '0' ? Record.STATE.EMPTY : Record.STATE.CLIENT
    }

    if (this._provided) {
      return Record.STATE.PROVIDER
    }

    if (this.version.charAt(0) === 'I') {
      return Record.STATE.STALE
    }

    return Record.STATE.SERVER
  },
})

Record.prototype.get = function (path) {
  invariant(this._usages > 0, this.name + ' must have refs')

  return jsonPath.get(this.data, path)
}

Record.prototype.set = function (pathOrData, dataOrNil) {
  invariant(this._usages > 0, this.name + ' must have refs')

  if (
    this._usages === 0 ||
    this._provided ||
    (this.version && this.version.charAt(0) === 'I') ||
    this.name.startsWith('_')
  ) {
    this._onError(C.EVENT.USER_ERROR, 'cannot set')
    return
  }

  const path = arguments.length === 1 ? undefined : pathOrData
  const data = arguments.length === 1 ? pathOrData : dataOrNil

  if (path === undefined && !utils.isPlainObject(data)) {
    throw new Error('invalid argument: data')
  }
  if (path === undefined && Object.keys(data).some((prop) => prop.startsWith('_'))) {
    throw new Error('invalid argument: data')
  }
  if (
    path !== undefined &&
    (typeof path !== 'string' || path.length === 0 || path.startsWith('_')) &&
    (!Array.isArray(path) || path.length === 0 || path[0].startsWith('_'))
  ) {
    throw new Error('invalid argument: path')
  }

  // TODO (perf): Avoid clone
  const jsonData = jsonPath.jsonClone(data)

  if (this._patchQueue) {
    this._patchQueue = path ? this._patchQueue : []
    this._patchQueue.push(path, jsonData)

    if (!this._pendingWrite.has(this)) {
      this.ref()
      this._pendingWrite.add(this)
    }
  } else if (!this._update(path, jsonData)) {
    return
  }

  this.emit('update', this)
}

Record.prototype.when = function (stateOrNull) {
  invariant(this._usages > 0, this.name + ' must have refs')

  const state = stateOrNull == null ? Record.STATE.SERVER : stateOrNull

  if (!Number.isFinite(state) || state < 0) {
    throw new Error('invalid argument: state')
  }

  return new Promise((resolve, reject) => {
    if (this.state >= state) {
      resolve()
      return
    }

    const onUpdate = () => {
      if (this.state < state) {
        return
      }

      // clearTimeout(timeout)

      this.off('update', onUpdate)
      this.unref()

      resolve()
    }

    // const timeout = setTimeout(() => {
    //   this.off('update', onUpdate)
    //   this.unref()

    //   reject(new Error('when timeout'))
    // }, 2 * 60e3)

    this.ref()
    this.on('update', onUpdate)
  })
}

Record.prototype.update = function (pathOrUpdater, updaterOrNil) {
  invariant(this._usages > 0, this.name + ' must have refs')

  if (this._usages === 0 || this._provided) {
    this._client._$onError(C.TOPIC.RECORD, C.EVENT.UPDATE_ERROR, 'cannot update', [
      this.name,
      this.version,
      this.state,
    ])
    return Promise.resolve()
  }

  if (this.version && this.version.charAt(0) === 'I') {
    this._client._$onError(C.TOPIC.RECORD, C.EVENT.UPDATE_ERROR, 'cannot update', [
      this.name,
      this.version,
      this.state,
    ])
    return Promise.resolve()
  }

  const path = arguments.length === 1 ? undefined : pathOrUpdater
  const updater = arguments.length === 1 ? pathOrUpdater : updaterOrNil

  if (typeof updater !== 'function') {
    throw new Error('invalid argument: updater')
  }

  if (
    path !== undefined &&
    (typeof path !== 'string' || path.length === 0 || path.startsWith('_')) &&
    (!Array.isArray(path) || path.length === 0 || path[0].startsWith('_'))
  ) {
    throw new Error('invalid argument: path')
  }

  this.ref()
  return this.when(Record.STATE.SERVER)
    .then(() => {
      const prev = this.get(path)
      const next = updater(prev, this.version)
      this.set(path, next)
    })
    .finally(() => {
      this.unref()
    })
}

Record.prototype.ref = function () {
  this._usages += 1
  if (this._usages === 1) {
    this._prune.delete(this)
    if (this.connected) {
      this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.SUBSCRIBE, [this.name])
    }
  }
}

Record.prototype.unref = function () {
  invariant(this._usages > 0, this.name + ' must have refs')

  this._usages -= 1
  if (this._usages === 0) {
    this._prune.set(this, this._handler._now)
  }
}

Record.prototype._$onMessage = function (message) {
  if (message.action === C.ACTIONS.UPDATE) {
    this._onUpdate(message.data)
  } else if (message.action === C.ACTIONS.READ) {
    this._onRead(message.data)
  } else if (message.action === C.ACTIONS.SUBSCRIPTION_HAS_PROVIDER) {
    this._onSubscriptionHasProvider(message.data)
  } else {
    return false
  }

  return true
}

Record.prototype._onSubscriptionHasProvider = function (data) {
  const provided = Boolean(data && data[1] && messageParser.convertTyped(data[1], this._client))

  if (this._provided !== provided) {
    this._provided = provided
    this.emit('update', this)
  }
}

Record.prototype._update = function (path, data) {
  invariant(this._entry[0], this.name + ' _update must have version')
  invariant(this._entry[1], this.name + ' _update must have data')

  const prevData = this._entry[1]
  const nextData = jsonPath.set(prevData, path, data, true)

  if (nextData === prevData) {
    return false
  }

  const prevVersion = this._entry[0]
  const nextVersion = this._makeVersion(parseInt(prevVersion) + 1)

  this._entry = [nextVersion, nextData, prevVersion]

  const update = [this.name, nextVersion, JSON.stringify(nextData), prevVersion]

  this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.UPDATE, update)

  this._updates ??= new Map()
  this._updates.set(nextVersion, update)

  return true
}

Record.prototype._onRead = function ([name, version]) {
  if (utils.compareRev(this._entry[0], version) === 0) {
    this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.UPDATE, [
      this.name,
      this._entry[0],
      JSON.stringify(this._entry[1]),
      this._entry[2] || '',
    ])
  }
}

Record.prototype._onUpdate = function ([name, version, data]) {
  try {
    if (!version) {
      throw new Error('missing version')
    }

    const prevData = this.data
    const prevVersion = this.version

    if (this._updates?.delete(version) && this._updates.size === 0) {
      this._updates = null
    }

    const cmp = utils.compareRev(version, this._entry[0])

    if (cmp === 0) {
      // Do nothing...
    } else if (cmp > 0 || version.charAt(0) === 'I') {
      if (data === '{}') {
        data = jsonPath.EMPTY_OBJ
      } else if (data === '[]') {
        data = jsonPath.EMPTY_ARR
      } else if (this._entry) {
        data = jsonPath.set(this._entry[1], null, JSON.parse(data), true)
      } else {
        data = JSON.parse(data)
      }
      this._entry = [version, data, null]
    } else {
      this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.UPDATE, [
        this.name,
        this._entry[0],
        JSON.stringify(this._entry[1]),
        this._entry[2] || '',
      ])
    }

    invariant(this._entry[0], this.name + ' missing version')
    invariant(this._entry[1], this.name + ' missing data')

    if (this._patchQueue) {
      if (this._entry[0].charAt(0) !== 'I') {
        for (let i = 0; i < this._patchQueue.length; i += 2) {
          this._update(this._patchQueue[i + 0], this._patchQueue[i + 1])
        }
      } else if (this._patchQueue.length) {
        this._onError(C.EVENT.USER_ERROR, 'cannot patch provided value')
      }

      this._patchQueue = null
      this._patchData = null

      if (this._pendingWrite.delete(this)) {
        this.unref()
      }

      this.emit('ready')
      this.emit('update', this)
    } else if (this.version !== prevVersion || this.data !== prevData) {
      this.emit('update', this)
    }
  } catch (err) {
    this._onError(C.EVENT.UPDATE_ERROR, err, [this.name, version, data])
  }
}

Record.prototype._$handleConnectionStateChange = function () {
  if (this.connected) {
    if (this._usages) {
      this._connection.sendMsg1(C.TOPIC.RECORD, C.ACTIONS.SUBSCRIBE, this.name)
    }

    if (this._updates) {
      for (const update of this._updates.values()) {
        this._connection.sendMsg1(C.TOPIC.RECORD, C.ACTIONS.UPDATE, update)
      }
    }
  } else {
    this._provided = false
    this._patchQueue = this._patchQueue || []
  }

  this.emit('update', this)
}

Record.prototype._onError = function (event, msgOrError, data) {
  this._client._$onError(C.TOPIC.RECORD, event, msgOrError, [
    ...(Array.isArray(data) ? data : []),
    this.name,
    this.version,
    this.state,
  ])
}

Record.prototype._makeVersion = function (start) {
  let revid = `${xuid()}-${this._client.user || ''}`
  if (revid.length === 32 || revid.length === 16) {
    // HACK: https://github.com/apache/couchdb/issues/2015
    revid += '-'
  }
  return `${start}-${revid}`
}

// Compat

Record.prototype.acquire = Record.prototype.ref
Record.prototype.discard = Record.prototype.unref
Record.prototype.destroy = Record.prototype.unref

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'connected', {
  get: function connected() {
    return this._client.getConnectionState() === C.CONNECTION_STATE.OPEN
  },
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'empty', {
  get: function empty() {
    return Object.keys(this.data).length === 0
  },
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'ready', {
  get: function ready() {
    return !this._patchQueue
  },
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'provided', {
  get: function provided() {
    return this.state >= C.RECORD_STATE.PROVIDER
  },
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'usages', {
  get: function usages() {
    return this._usages
  },
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'stale', {
  get: function ready() {
    return !this.version
  },
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'isReady', {
  get: function isReady() {
    return !this._patchQueue
  },
})

// TODO (fix): Remove
Object.defineProperty(Record.prototype, 'hasProvider', {
  get: function hasProvider() {
    return this.state >= C.RECORD_STATE.PROVIDER
  },
})

module.exports = Record
