const Record = require('./record')
const MulticastListener = require('../utils/multicast-listener')
const UnicastListener = require('../utils/unicast-listener')
const C = require('../constants/constants')
const rxjs = require('rxjs')
const invariant = require('invariant')
const EventEmitter = require('component-emitter2')
const jsonPath = require('@nxtedition/json-path')
const utils = require('../utils/utils')
const rx = require('rxjs/operators')
const xuid = require('xuid')
const timers = require('../utils/timers')

const kEmpty = Symbol('kEmpty')

class RecordHandler {
  constructor(options, connection, client) {
    this.JSON = jsonPath
    this.STATE = C.RECORD_STATE
    Object.assign(this, C.RECORD_STATE)

    this._options = options
    this._connection = connection
    this._client = client
    this._records = new Map()
    this._listeners = new Map()
    this._pending = new Map()
    this._pruning = new Set()

    this._connected = 0
    this._stats = {
      updating: 0,
      created: 0,
      destroyed: 0,
      records: 0,
      pending: 0,
      pruning: 0,
      patching: 0,
    }

    this._syncEmitter = new EventEmitter()
    this._readyEmitter = new EventEmitter()

    this.set = this.set.bind(this)
    this.get = this.get.bind(this)
    this.update = this.update.bind(this)
    this.observe = this.observe.bind(this)
    this.observe2 = this.observe2.bind(this)
    this.sync = this.sync.bind(this)
    this.provide = this.provide.bind(this)
    this.getRecord = this.getRecord.bind(this)

    this._client.on(C.EVENT.CONNECTED, this._onConnectionStateChange.bind(this))

    this._pruningTimeout = null

    const _prune = () => {
      const pruning = this._pruning
      this._pruning = new Set()

      for (const rec of pruning) {
        rec._$dispose()

        this._stats.records -= 1
        this._stats.destroyed += 1
        this._records.delete(rec.name)
      }

      if (this._pruningTimeout) {
        this._pruningTimeout.refresh()
      } else {
        this._pruningTimeout = timers.setTimeout(_prune, 1e3)
      }
    }

    _prune()
  }

  _onPruning(rec, isPruning) {
    if (isPruning) {
      this._stats.pruning += 1
    } else {
      this._stats.pruning -= 1
    }

    if (isPruning) {
      this._pruning.add(rec)
    } else {
      this._pruning.delete(rec)
    }
  }

  _onPending(rec, value) {
    if (value) {
      this._stats.pending += 1
    } else {
      this._stats.pending -= 1
    }

    if (value) {
      this._pending.set(rec, [])
    } else {
      for (const callback of this._pending.get(rec)) {
        callback()
      }
      this._pending.delete(rec)
    }
  }

  _onUpdating(rec, value) {
    if (value) {
      this._stats.updating += 1
    } else {
      this._stats.updating -= 1
    }
  }

  _onPatching(rec, value) {
    if (value) {
      this._stats.patching += 1
    } else {
      this._stats.patching -= 1
    }
  }

  get connected() {
    return Boolean(this._connected)
  }

  get stats() {
    return this._stats
  }

  getRecord(name) {
    invariant(
      typeof name === 'string' && name.length > 0 && name !== '[object Object]',
      `invalid name ${name}`
    )

    let record = this._records.get(name)

    if (!record) {
      record = new Record(name, this)
      this._stats.records += 1
      this._stats.created += 1
      this._records.set(name, record)
    }

    return record.ref()
  }

  provide(pattern, callback, options) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error('invalid argument pattern')
    }
    if (typeof callback !== 'function') {
      throw new Error('invalid argument callback')
    }

    if (!options) {
      options = { recursive: false, stringify: null }
    } else if (options === true) {
      options = { recursive: true, stringify: null }
    }

    if (this._listeners.has(pattern)) {
      this._client._$onError(C.TOPIC.RECORD, C.EVENT.LISTENER_EXISTS, new Error(pattern))
      return
    }

    const listener =
      options.mode?.toLowerCase() === 'unicast'
        ? new UnicastListener(C.TOPIC.RECORD, pattern, callback, this, options)
        : new MulticastListener(C.TOPIC.RECORD, pattern, callback, this, options)

    this._stats.listeners += 1
    this._listeners.set(pattern, listener)

    return () => {
      listener._$destroy()

      this._stats.listeners -= 1
      this._listeners.delete(pattern)
    }
  }

  sync() {
    // TODO (fix): Sync patching & updating?
    return new Promise((resolve) => {
      let counter = this._pending.size + 1

      const maybeSync = () => {
        counter -= 1
        if (counter > 0) {
          return
        }

        const token = xuid()
        this._syncEmitter.once(token, resolve)
        this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.SYNC, [token])
      }

      for (const callbacks of this._pending.values()) {
        callbacks.push(maybeSync)
      }

      maybeSync()
    })
  }

  set(name, ...args) {
    const record = this.getRecord(name)
    try {
      return record.set(...args)
    } finally {
      record.unref()
    }
  }

  update(name, ...args) {
    try {
      const record = this.getRecord(name)
      try {
        return record.update(...args)
      } finally {
        record.unref()
      }
    } catch (err) {
      return Promise.reject(err)
    }
  }

  observe(...args) {
    return this._observe(
      {
        state: C.RECORD_STATE.SERVER,
        timeout: 10 * 60e3,
        dataOnly: true,
      },
      ...args
    )
  }

  get(...args) {
    return new Promise((resolve, reject) => {
      this.observe(...args)
        .pipe(rx.first())
        .subscribe({
          next: resolve,
          error: reject,
        })
    })
  }

  observe2(...args) {
    return this._observe(null, ...args)
  }

  _observe(defaults, name, ...args) {
    let path
    let state = defaults ? defaults.state : undefined
    let signal
    let timeoutValue = defaults ? defaults.timeout : undefined
    let dataOnly = defaults ? defaults.dataOnly : undefined

    let idx = 0

    if (idx < args.length && (args[idx] == null || typeof args[idx] === 'string')) {
      path = args[idx++]
    }

    if (idx < args.length && (args[idx] == null || typeof args[idx] === 'number')) {
      state = args[idx++]
    }

    if (idx < args.length && (args[idx] == null || typeof args[idx] === 'object')) {
      const options = args[idx++] || {}

      if (options.signal != null) {
        signal = options.signal
      }

      if (options.timeout != null) {
        timeoutValue = options.timeout
      }

      if (options.path != null) {
        path = options.path
      }

      if (options.state != null) {
        state = options.state
      }

      if (options.dataOnly != null) {
        dataOnly = options.dataOnly
      }
    }

    if (typeof state === 'string') {
      state = C.RECORD_STATE[state.toUpperCase()]
    }

    if (!name) {
      const data = path ? undefined : jsonPath.EMPTY
      return rxjs.of(
        dataOnly
          ? data
          : utils.deepFreeze({
              name,
              version: '0-00000000000000',
              data,
              state: Number.isFinite(state) ? state : C.RECORD_STATE.SERVER,
            })
      )
    }

    if (signal?.aborted) {
      return rxjs.throwError(() => new utils.AbortError())
    }

    return new rxjs.Observable((o) => {
      let timeoutHandle
      let prevData = kEmpty

      const onUpdate = (record) => {
        if (state && record.state < state) {
          return
        }

        if (timeoutHandle) {
          timers.clearTimeout(timeoutHandle)
          timeoutHandle = null
        }

        const nextData = path ? record.get(path) : record.data

        if (dataOnly) {
          if (nextData !== prevData) {
            prevData = nextData
            o.next(nextData)
          }
        } else {
          o.next({
            name: record.name,
            version: record.version,
            data: nextData,
            state: record.state,
          })
        }
      }

      const record = this.getRecord(name).subscribe(onUpdate)

      if (timeoutValue && state && record.state < state) {
        timeoutHandle = timers.setTimeout(() => {
          const expected = C.RECORD_STATE_NAME[state]
          const current = C.RECORD_STATE_NAME[record.state]
          o.error(
            Object.assign(
              new Error(
                `timeout after ${timeoutValue / 1e3}s: ${record.name} [${current}<${expected}]`
              ),
              { code: 'ETIMEDOUT' }
            )
          )
        }, timeoutValue)
      }

      if (record.version) {
        onUpdate(record)
      }

      const abort = signal ? () => o.error(new utils.AbortError()) : null

      utils.addAbortListener(signal, abort)

      return () => {
        record.unsubscribe(onUpdate).unref()
        utils.removeAbortListener(signal, abort)
      }
    })
  }

  _$handle(message) {
    let name
    if (message.action === C.ACTIONS.ERROR) {
      name = message.data[1]
    } else {
      name = message.data[0]
    }

    if (message.action === C.ACTIONS.SYNC) {
      this._syncEmitter.emit(message.data[0])
      return true
    }

    const listener = this._listeners.get(name)
    if (listener && listener._$onMessage(message)) {
      return true
    }

    const record = this._records.get(name)
    if (record && record._$onMessage(message)) {
      return true
    }

    return false
  }

  _onConnectionStateChange(connected) {
    for (const listener of this._listeners.values()) {
      listener._$onConnectionStateChange(connected)
    }

    for (const record of this._records.values()) {
      record._$onConnectionStateChange(connected)
    }

    if (connected) {
      this._connected = Date.now()
      for (const token of this._syncEmitter.eventNames()) {
        this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.SYNC, [token])
      }
    } else {
      this._connected = 0
    }
  }
}

module.exports = RecordHandler
