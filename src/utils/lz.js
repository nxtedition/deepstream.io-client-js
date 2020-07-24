const assert = require('assert')

// Node 12+
if (process && process.version && /v(\d\d\d+|\d[2-9]|[2-9]\d)/.test(process.version)) {
  const { Worker, isMainThread, parentPort, workerData } = require('worker_threads')

  if (isMainThread) {
    const kCallbacks = Symbol('callbacks')
    const kCallbacksIndex = Symbol('callbacksIndex')

    class LZWorker extends Worker {
      constructor (type) {
        super(__filename, { workerData: { type } })
        this[kCallbacks] = []
        this[kCallbacksIndex] = 0

        this.on('message', function (msg) {
          const cb = this[kCallbacks][this[kCallbacksIndex]]
          this[kCallbacks][this[kCallbacksIndex]++] = null

          if (this[kCallbacksIndex] > 1024) {
            this[kCallbacks].splice(0, this[kCallbacksIndex])
            this[kCallbacksIndex] = 0
          }

          cb(null, msg)
        })
      }

      dispatch (data, cb) {
        this[kCallbacks].push(cb)
        this.postMessage(data)
      }
    }

    const compress = new LZWorker('compress')
    const decompress = new LZWorker('decompress')

    module.exports.compress = function (data, cb) {
      compress.dispatch(data, cb)
    }

    module.exports.decompress = function (data, cb) {
      decompress.dispatch(data, cb)
    }
  } else {
    const lz = require('@nxtedition/lz-string')

    const handler = {
      compress (data) {
        parentPort.postMessage(lz.compressToUTF16(data))
      },
      decompress (data) {
        parentPort.postMessage(lz.decompressFromUTF16(data))
      }
    }[workerData.type]

    assert(handler)

    parentPort.on('message', handler)
  }
} else {
  const lz = require('@nxtedition/lz-string')

  module.exports.compress = function (data, cb) {
    try {
      cb(null, lz.compressToUTF16(data))
    } catch (err) {
      cb(err)
    }
  }

  module.exports.decompress = function (data, cb) {
    try {
      cb(null, lz.decompressFromUTF16(data))
    } catch (err) {
      cb(err)
    }
  }
}
