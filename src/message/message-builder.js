import * as C from '../constants/constants.js'
import varint from 'varint'
import * as utils from '../utils/utils.js'

const poolEncoder = new TextEncoder()

let poolSize
let poolBuffer
let poolView
let poolOffset

function allocPool(size) {
  poolSize = size || poolSize || 1024 * 1024
  poolBuffer = utils.isNode
    ? globalThis.Buffer.allocUnsafe(poolSize)
    : new Uint8Array(new ArrayBuffer(poolSize))
  poolView = new DataView(poolBuffer.buffer)
  poolOffset = 0
}

function alignPool() {
  // Ensure aligned slices
  if (poolOffset & 0x7) {
    poolOffset |= 0x7
    poolOffset++
  }
}

function writeString(dst, str, offset) {
  if (utils.isNode) {
    return dst.write(str, offset)
  } else {
    const res = poolEncoder.encodeInto(str, new Uint8Array(dst.buffer, offset))
    return res.written
  }
}

export function getMsg(topic, action, data) {
  if (data && !(data instanceof Array)) {
    throw new Error('data must be an array')
  }

  if (!poolSize || poolOffset + poolSize / 16 >= poolSize) {
    allocPool()
  } else {
    alignPool()
  }

  const start = poolOffset

  const headerSize = 8
  poolBuffer[poolOffset++] = 128 + headerSize
  let headerPos = poolOffset
  poolOffset += headerSize - 1

  poolBuffer[poolOffset++] = topic.charCodeAt(0)
  poolBuffer[poolOffset++] = 31
  for (let n = 0; n < action.length; n++) {
    poolBuffer[poolOffset++] = action.charCodeAt(n)
  }

  if (data) {
    for (let i = 0; i < data.length; i++) {
      const type = typeof data[i]
      let len
      if (data[i] == null) {
        poolBuffer[poolOffset++] = 31
        len = 0
      } else if (type === 'object') {
        poolBuffer[poolOffset++] = 31
        len = writeString(poolBuffer, JSON.stringify(data[i]), poolOffset)
      } else if (type === 'bigint') {
        poolBuffer[poolOffset++] = 31
        poolView.setBigUint64(poolOffset, data[i], false)
        len = 8
      } else if (type === 'string') {
        poolBuffer[poolOffset++] = 31
        len = writeString(poolBuffer, data[i], poolOffset)
      } else {
        throw new Error('invalid data')
      }
      poolOffset += len

      varint.encode(len + 1, poolBuffer, headerPos)
      headerPos += varint.encode.bytes
      if (headerPos - start >= headerSize) {
        throw new Error(`header too large: ${headerPos - start} ${headerSize}`)
      }

      if (poolOffset >= poolBuffer.length) {
        allocPool(start === 0 ? poolSize * 2 : poolSize)
        return getMsg(topic, action, data)
      }
    }
  }

  return new Uint8Array(poolBuffer.buffer, start, poolOffset - start)
}

export function typed(value) {
  const type = typeof value

  if (type === 'string') {
    return C.TYPES.STRING + value
  }

  if (value === null) {
    return C.TYPES.NULL
  }

  if (type === 'object') {
    return C.TYPES.OBJECT + JSON.stringify(value)
  }

  if (type === 'number') {
    return C.TYPES.NUMBER + value.toString()
  }

  if (value === true) {
    return C.TYPES.TRUE
  }

  if (value === false) {
    return C.TYPES.FALSE
  }

  if (value === undefined) {
    return C.TYPES.UNDEFINED
  }

  throw new Error(`Can't serialize type ${value}`)
}
