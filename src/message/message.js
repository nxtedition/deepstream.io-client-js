const varint = require('varint')
const C = require('../constants/constants')

const FAST_HEADER_SIZE = 8
const FAST_HEADER_NUMBER = 128

const Uint8ArrayIndexOf = Uint8Array.prototype.indexOf

function toCode(val) {
  return val.split('').reduce((xs, x, index) => (xs << 8) | x.charCodeAt(0), 0)
}

const TOPIC_MAP = new Map()
for (const val of Object.values(C.TOPIC)) {
  TOPIC_MAP.set(toCode(val), val)
}

const ACTIONS_MAP = new Map()
for (const val of Object.values(C.ACTIONS)) {
  ACTIONS_MAP.set(toCode(val), val)
}

module.exports.decode = function (raw) {
  let pos = 0

  if (raw[0] === FAST_HEADER_NUMBER) {
    pos += FAST_HEADER_SIZE
  }

  const len = raw.byteLength
  const topic = raw[pos++]
  pos++

  let action = 0
  while (pos < len && raw[pos] !== 31) {
    action = (action << 8) | raw[pos++]
  }
  pos++

  const data = []

  if (raw[0] === FAST_HEADER_NUMBER) {
    let headerPos = 1
    while (headerPos < FAST_HEADER_SIZE) {
      const len = varint.decode(raw, headerPos)
      headerPos += varint.decode.bytes
      if (len === 0) {
        break
      }
      data.push(raw.toString('utf8', pos, pos + len - 1))
      pos += len
    }
  }

  while (pos < len) {
    let end = Uint8ArrayIndexOf.call(raw, 31, pos)
    end = end === -1 ? len : end
    data.push(raw.toString('utf8', pos, end))
    pos = end + 1
  }

  // TODO (perf): Make constant into codes...
  return { raw, topic: TOPIC_MAP.get(topic), action: ACTIONS_MAP.get(action), data }
}

let poolSize = 1024 * 1024
let poolBuffer = Buffer.allocUnsafe(poolSize)
let poolOffset = 0

module.exports.encode = function (topic, action, data) {
  if (poolBuffer.byteLength - poolOffset < poolSize / 16) {
    poolBuffer = Buffer.allocUnsafe(poolSize)
    poolOffset = 0
  }

  topic = typeof topic === 'number' ? topic : toCode(topic)
  action = typeof action === 'number' ? action : toCode(action)

  const buf = poolBuffer
  let pos = poolOffset

  const start = pos

  buf[pos++] = FAST_HEADER_NUMBER
  for (let n = 1; n < FAST_HEADER_SIZE; n++) {
    buf[pos++] = 0
  }

  if (action <= 0xff) {
    buf[pos++] = topic
    buf[pos++] = 31
    buf[pos++] = (action >> 0) & 0xff
  } else if (action <= 0xffff) {
    buf[pos++] = topic
    buf[pos++] = 31
    buf[pos++] = (action >> 8) & 0xff
    buf[pos++] = (action >> 0) & 0xff
  } else if (action <= 0xffffff) {
    buf[pos++] = topic
    buf[pos++] = 31
    buf[pos++] = (action >> 16) & 0xff
    buf[pos++] = (action >> 8) & 0xff
    buf[pos++] = (action >> 0) & 0xff
  }

  if (Array.isArray(data) && data.length > 0) {
    let headerPos = start + 1
    for (let n = 0, len = data.length; n < len; ++n) {
      let len = 0
      if (data[n] == null) {
        buf[pos++] = 31
        len = 0
      } else if (typeof data[n] === 'string') {
        buf[pos++] = 31
        len = buf.write(data[n], pos)
      } else if (Buffer.isBuffer(data[n])) {
        buf[pos++] = 31
        len = data[n].copy(buf, pos)
      } else {
        buf[pos++] = 31
        len = buf.write(JSON.stringify(data[n]), pos)
      }

      {
        const varintLen = varint.encodingLength(len)
        if (headerPos + varintLen - start < FAST_HEADER_SIZE) {
          varint.encode(len + 1, buf, headerPos)
          headerPos += varint.encode.bytes
        }
      }

      pos += len

      if (pos >= poolSize) {
        poolSize = start === 0 ? poolSize * 2 : poolSize
        poolBuffer = Buffer.allocUnsafe(poolSize)
        poolOffset = 0
        return module.exports.encode(topic, action, data)
      }
    }
  }

  poolOffset = pos

  return buf.subarray(start, pos)
}

exports.decodeTyped = function (value, client) {
  const type = value.charAt(0)

  if (type === C.TYPES.STRING) {
    return value.substr(1)
  }

  if (type === C.TYPES.OBJECT) {
    try {
      return JSON.parse(value.substr(1))
    } catch (err) {
      client._$onError(C.TOPIC.ERROR, C.EVENT.MESSAGE_PARSE_ERROR, err)
      return undefined
    }
  }

  if (type === C.TYPES.NUMBER) {
    return parseFloat(value.substr(1))
  }

  if (type === C.TYPES.NULL) {
    return null
  }

  if (type === C.TYPES.TRUE) {
    return true
  }

  if (type === C.TYPES.FALSE) {
    return false
  }

  if (type === C.TYPES.UNDEFINED) {
    return undefined
  }

  client._$onError(C.TOPIC.ERROR, C.EVENT.MESSAGE_PARSE_ERROR, new Error(`UNKNOWN_TYPE (${value})`))

  return undefined
}

module.exports.encodeTyped = function (value) {
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
