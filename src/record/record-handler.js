import Record from './record.js'
import LegacyListener from '../utils/legacy-listener.js'
import UnicastListener from '../utils/unicast-listener.js'
import * as C from '../constants/constants.js'
import * as rxjs from 'rxjs'
import invariant from 'invariant'
import jsonPath from '@nxtedition/json-path'
import * as utils from '../utils/utils.js'
import xuid from 'xuid'
import * as timers from '../utils/timers.js'

/** @import {Timeout} from '../utils/timers.js' */

function noop() {}

const kEmpty = Symbol('kEmpty')

const OBSERVE_DEFAULTS = {
  timeout: 2 * 60e3,
  state: C.RECORD_STATE.SERVER,
  dataOnly: true,
}
const OBSERVE2_DEFAULTS = {
  timeout: 2 * 60e3,
}
const GET_DEFAULTS = {
  timeout: 2 * 60e3,
  sync: true,
  dataOnly: true,
}
const GET2_DEFAULTS = {
  timeout: 2 * 60e3,
  sync: true,
}

function onSync(subscription) {
  subscription.synced = true
  onUpdate(subscription.record, subscription)
}

function onUpdate(record, subscription) {
  if (!subscription.record) {
    return
  }

  if (!subscription.synced || subscription.record.state < subscription.state) {
    if (subscription.timeoutValue > 0) {
      if (!subscription.timeout) {
        subscription.timeout = timers.setTimeout(onTimeout, subscription.timeoutValue, subscription)
      } else {
        subscription.timeout.refresh()
      }
    }
    return
  }

  if (subscription.timeout) {
    timers.clearTimeout(subscription.timeout)
    subscription.timeout = null
  }

  const data = subscription.path
    ? subscription.record.get(subscription.path)
    : subscription.record.data

  if (subscription.dataOnly) {
    if (data !== subscription.data) {
      subscription.data = data
      subscription.subscriber.next(data)
    }
  } else {
    subscription.subscriber.next({
      name: subscription.record.name,
      version: subscription.record.version,
      state: subscription.record.state,
      data,
    })
  }
}

function onTimeout(subscription) {
  const expected = C.RECORD_STATE_NAME[subscription.state]
  const current = C.RECORD_STATE_NAME[subscription.record.state]

  subscription.subscriber.error(
    Object.assign(
      new Error(
        !subscription.synced
          ? `timeout sync: ${subscription.record.name}`
          : `timeout state: ${subscription.record.name} [${current}<${expected}]`,
      ),
      {
        code: 'ETIMEDOUT',
        timeout: subscription.timeoutValue,
        expected,
        current,
        synced: subscription.synced,
        name: subscription.record.name,
      },
    ),
  )
}

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
    this._pruning = new Set()
    this._patching = new Map()
    this._updating = new Map()
    this._putting = new Map()

    this._connected = 0
    this._stats = {
      updating: 0,
      created: 0,
      destroyed: 0,
      records: 0,
      pruning: 0,
      patching: 0,
    }

    this._syncQueue = []
    this._syncMap = {}

    this.set = this.set.bind(this)
    this.get = this.get.bind(this)
    this.update = this.update.bind(this)
    this.observe = this.observe.bind(this)
    this.observe2 = this.observe2.bind(this)
    this.sync = this.sync.bind(this)
    this.provide = this.provide.bind(this)
    this.getRecord = this.getRecord.bind(this)

    this._client.on(C.EVENT.CONNECTED, this._onConnectionStateChange.bind(this))

    const _prune = () => {
      const pruning = this._pruning
      this._pruning = new Set()

      for (const rec of pruning) {
        rec._$dispose()
        this._records.delete(rec.name)
      }

      this._stats.pruning -= pruning.size
      this._stats.records -= pruning.size
      this._stats.destroyed += pruning.size

      this._pruningTimeout.refresh()
    }

    this._pruningTimeout = timers.setTimeout(_prune, 1e3)
  }

  _onPruning(rec, value) {
    if (value) {
      this._stats.pruning += 1
    } else {
      this._stats.pruning -= 1
    }

    if (value) {
      this._pruning.add(rec)
    } else {
      this._pruning.delete(rec)
    }
  }

  _onUpdating(rec, value) {
    const callbacks = this._updating.get(rec)

    if (value) {
      invariant(!callbacks, 'updating callbacks must not exist')
      this._stats.updating += 1
      this._updating.set(rec, [])
    } else {
      invariant(callbacks, 'updating callbacks must exist')

      this._stats.updating -= 1
      this._updating.delete(rec)
      for (const callback of callbacks) {
        callback()
      }
    }
  }

  _onPatching(rec, value) {
    if (value) {
      this._stats.patching += 1
      this._patching.set(rec, [])
    } else {
      this._stats.patching -= 1

      const callbacks = this._patching.get(rec)
      this._patching.delete(rec)
      for (const callback of callbacks) {
        callback()
      }
    }
  }

  get connected() {
    return Boolean(this._connected)
  }

  get stats() {
    let subscriptions = 0
    for (const listener of this._listeners.values()) {
      subscriptions += listener.subscriptions ?? 0
    }

    return {
      ...this._stats,
      subscriptions,
    }
  }

  /**
   * @param {string} name
   * @returns {Record}
   */
  getRecord(name) {
    invariant(
      typeof name === 'string' &&
        name.length > 0 &&
        name !== '[object Object]' &&
        name.length <= 4096,
      `invalid name ${name}`,
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
        : new LegacyListener(C.TOPIC.RECORD, pattern, callback, this, options)

    this._stats.listeners += 1
    this._listeners.set(pattern, listener)

    const disposer = () => {
      listener._$destroy()

      this._stats.listeners -= 1
      this._listeners.delete(pattern)
    }
    disposer[Symbol.dispose] = disposer

    return disposer
  }

  async sync(opts) {
    // TODO (fix): Sync pending? What about VOID state?
    // TODO (perf): Slow implementation...

    const signal = opts?.signal
    const timeout = opts?.timeout ?? 10 * 60e3

    let disposers
    try {
      const signalPromise = signal
        ? new Promise((resolve, reject) => {
            const onAbort = () => reject(signal.reason ?? new utils.AbortError())
            signal.addEventListener('abort', onAbort)
            disposers ??= []
            disposers.push(() => signal.removeEventListener('abort', onAbort))
          })
        : null

      signalPromise?.catch(noop)

      if (this._patching.size) {
        const promises = []

        {
          const patchingPromises = []
          for (const callbacks of this._patching.values()) {
            patchingPromises.push(new Promise((resolve) => callbacks.push(resolve)))
          }
          promises.push(Promise.all(patchingPromises))
        }

        if (timeout && promises.length) {
          promises.push(
            new Promise((resolve) => {
              const patchingTimeout = timers.setTimeout(() => {
                this._client._$onError(
                  C.TOPIC.RECORD,
                  C.EVENT.TIMEOUT,
                  new Error('sync patching timeout'),
                )
                resolve(null)
              }, timeout)
              disposers ??= []
              disposers.push(() => timers.clearTimeout(patchingTimeout))
            }),
          )
        }

        if (signalPromise && promises.length) {
          promises.push(signalPromise)
        }

        if (promises.length) {
          await Promise.race(promises)
          signal?.throwIfAborted()
        }
      }

      if (this._updating.size) {
        const promises = []

        {
          const updatingPromises = []
          for (const callbacks of this._updating.values()) {
            updatingPromises.push(new Promise((resolve) => callbacks.push(resolve)))
          }
          promises.push(Promise.all(updatingPromises))
        }

        if (timeout && promises.length) {
          promises.push(
            new Promise((resolve) => {
              const updatingTimeout = timers.setTimeout(() => {
                this._client._$onError(
                  C.TOPIC.RECORD,
                  C.EVENT.TIMEOUT,
                  new Error('sync updating timeout'),
                )
                resolve(null)
              }, timeout)
              disposers ??= []
              disposers.push(() => timers.clearTimeout(updatingTimeout))
            }),
          )
        }

        if (signalPromise && promises.length) {
          promises.push(signalPromise)
        }

        if (promises.length) {
          await Promise.race(promises)
          signal?.throwIfAborted()
        }
      }

      {
        const promises = []

        promises.push(new Promise((resolve) => this._sync(resolve)))

        if (timeout) {
          promises.push(
            new Promise((resolve, reject) => {
              const serverTimeout = timers.setTimeout(() => {
                reject(new Error('sync server timeout'))
              }, timeout)
              disposers ??= []
              disposers.push(() => timers.clearTimeout(serverTimeout))
            }),
          )
        }

        if (signalPromise) {
          promises.push(signalPromise)
        }

        if (promises.length) {
          await Promise.race(promises)
          signal?.throwIfAborted()
        }
      }
    } finally {
      if (disposers) {
        for (const disposer of disposers) {
          disposer()
        }
      }
    }
  }

  set(name, ...args) {
    const record = this.getRecord(name)
    try {
      return record.set(...args)
    } finally {
      record.unref()
    }
  }

  put(name, version, data, parent) {
    if (typeof name !== 'string' || name.startsWith('_')) {
      throw new Error('invalid argument: name')
    }

    if (typeof version !== 'string' || !/^\d+-/.test(version)) {
      throw new Error('invalid argument: verison')
    }

    if (typeof data !== 'object' && data != null) {
      throw new Error('invalid argument: data')
    }

    if (parent != null && (typeof version !== 'string' || !/^\d+-/.test(version))) {
      throw new Error('invalid argument: parent')
    }

    const update = [name, version, jsonPath.stringify(data)]

    if (parent) {
      update.push(parent)
    }

    this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.PUT, update)

    this._putting.set(update, [])
    this._sync((update) => this._putting.delete(update), 'WEAK', update)
  }

  /**
   *
   * @param {*} name
   * @param  {...any} args
   * @returns {Promise}
   */
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

  /**
   * @param {string} name
   * @param  {...any} args
   * @returns {rxjs.Observable}
   */
  observe(name, ...args) {
    return this._observe(OBSERVE_DEFAULTS, name, ...args)
  }

  /**
   * @param {string} name
   * @param  {...any} args
   * @returns {rxjs.Observable<{ name: string, version: string, state: Number, data: any}>}
   */
  observe2(name, ...args) {
    return this._observe(OBSERVE2_DEFAULTS, name, ...args)
  }

  /**
   * @param {string} name
   * @param  {...any} args
   * @returns { { value: object, async: false } | { value: Promise<object>, async: true } }
   */
  getAsync(name, ...args) {
    let path
    let state = GET_DEFAULTS.state ?? C.RECORD_STATE.CLIENT

    let idx = 0

    if (
      idx < args.length &&
      (args[idx] == null ||
        typeof args[idx] === 'string' ||
        Array.isArray(args[idx]) ||
        typeof args[idx] === 'function')
    ) {
      path = args[idx++]
    }

    if (idx < args.length && (args[idx] == null || typeof args[idx] === 'number')) {
      state = args[idx++]
    }

    if (idx < args.length && (args[idx] == null || typeof args[idx] === 'object')) {
      return { value: this.get(name, ...args), async: true }
    }

    if (typeof state === 'string') {
      state = C.RECORD_STATE[state.toUpperCase()]
    }

    if (!Number.isInteger(state) || state < 0) {
      throw new Error('invalid argument: state')
    }

    const rec = this.getRecord(name)
    try {
      return rec.state >= state
        ? { value: rec.get(path), async: false }
        : { value: this.get(name, ...args), async: true }
    } finally {
      rec.unref()
    }
  }

  /**
   * @param {string} name
   * @param  {...any} args
   * @returns {Promise<object>}
   */
  get(name, ...args) {
    return rxjs.firstValueFrom(this._observe(GET_DEFAULTS, name, ...args))
  }

  /**
   * @param {string} name
   * @param  {...any} args
   * @returns {Promise<object>}
   */
  get2(name, ...args) {
    return rxjs.firstValueFrom(this._observe(GET2_DEFAULTS, name, ...args))
  }

  /**
   * @returns {rxjs.Observable}
   */
  _observe(defaults, name, ...args) {
    return new rxjs.Observable((subscriber) => {
      let path
      let state = defaults?.state ?? C.RECORD_STATE.CLIENT
      let signal = null
      let timeout = defaults?.timeout ?? 0
      let dataOnly = defaults?.dataOnly ?? false
      let sync = defaults?.sync ?? false

      let idx = 0

      if (
        idx < args.length &&
        (args[idx] == null ||
          typeof args[idx] === 'string' ||
          Array.isArray(args[idx]) ||
          typeof args[idx] === 'function')
      ) {
        path = args[idx++]
      }

      if (idx < args.length && (args[idx] == null || typeof args[idx] === 'number')) {
        state = args[idx++]
      }

      if (idx < args.length && (args[idx] == null || typeof args[idx] === 'object')) {
        const options = args[idx++] || {}

        if (options.signal !== undefined) {
          signal = options.signal
        }

        if (options.timeout !== undefined) {
          timeout = options.timeout
        }

        if (options.path !== undefined) {
          path = options.path
        }

        if (options.state !== undefined) {
          state = options.state
        }

        if (options.dataOnly !== undefined) {
          dataOnly = options.dataOnly
        }

        if (options.sync !== undefined) {
          sync = options.sync
        }
      }

      if (typeof state === 'string') {
        state = C.RECORD_STATE[state.toUpperCase()]
      }

      if (!Number.isInteger(state) || state < 0) {
        throw new Error('invalid argument: state')
      }

      if (!Number.isInteger(timeout) || timeout < 0) {
        throw new Error('invalid argument: timeout')
      }

      if (typeof dataOnly !== 'boolean') {
        throw new Error('invalid argument: dataOnly')
      }

      if (typeof sync !== 'boolean') {
        throw new Error('invalid argument: sync')
      }

      // TODO (perf): Make a class
      const subscription = {
        /** @readonly @type {unknown} */
        subscriber,
        /** @readonly @type {unknown} */
        path,
        /** @readonly @type {number} */
        state,
        /** @type {AbortSignal|null} */
        signal,
        /** @readonly @type {boolean} */
        dataOnly,
        /** @readonly @type {number} */
        timeoutValue: timeout,

        /** @type {Record|null} */
        record: null,
        /** @type {Timeout|null} */
        timeout: null,
        /** @type {Function?} */
        abort: null,
        /** @type {object|Array} */
        data: kEmpty,
        /** @type {boolean} */
        synced: false,
      }

      subscriber.add(() => {
        if (subscription.timeout) {
          timers.clearTimeout(subscription.timeout)
          subscription.timeout = null
        }

        if (subscription.signal) {
          utils.removeAbortListener(subscription.signal, subscription.abort)
          subscription.abort = null
          subscription.signal = null
        }

        if (subscription.record) {
          subscription.record.unsubscribe(onUpdate, subscription)
          subscription.record.unref()
          subscription.record = null
        }
      })

      if (subscription.signal) {
        subscription.abort = () => subscriber.error(new utils.AbortError())
        utils.addAbortListener(subscription.signal, subscription.abort)
      }

      subscription.record = this.getRecord(name).subscribe(onUpdate, subscription)

      if (sync) {
        this._sync(onSync, sync === true ? 'WEAK' : sync, subscription)
      } else {
        onSync(subscription)
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
      const [token] = message.data
      if (!token) {
        return true
      }

      const sync = this._syncMap[token]
      delete this._syncMap[token]

      if (!sync) {
        return true
      }

      const { queue } = sync
      for (let n = 0; n < queue.length; n += 2) {
        queue[n](queue[n + 1])
      }

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

      for (const update of this._putting.keys()) {
        this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.PUT, update)
      }

      const syncMap = {}
      for (const sync of Object.values(this._syncMap)) {
        const token = xuid()
        syncMap[token] = sync
        this._connection.sendMsg(
          C.TOPIC.RECORD,
          C.ACTIONS.SYNC,
          sync.type ? [token, sync.type] : [token],
        )
      }
      this._syncMap = syncMap
    } else {
      this._connected = 0
    }
  }

  _sync(callback, type, opaque) {
    this._syncQueue.push(callback, opaque)

    if (this._syncQueue.length > 2) {
      return
    }

    if (type == null) {
      type = null
    } else if (type === true) {
      type = 'WEAK'
    } else if (type !== 'WEAK' && type !== 'STRONG') {
      throw new Error(`invalid sync type: ${type}`)
    }

    // TODO (fix): timeout?
    setTimeout(() => {
      // Token must be universally unique until deepstream properly separates
      // sync requests from different sockets.
      const token = xuid()
      const queue = this._syncQueue.splice(0)

      this._syncMap[token] = { queue, type }
      this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.SYNC, type ? [token, type] : [token])
    }, 1)
  }
}

export default RecordHandler
