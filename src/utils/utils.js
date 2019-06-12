const URL = require('url')

const hasUrlProtocol = /^wss:|^ws:|^\/\//
const unsupportedProtocol = /^http:|^https:/

const NODE_ENV = process.env.NODE_ENV
const isNode = typeof process !== 'undefined' && process.toString() === '[object process]'

module.exports.isNode = isNode

module.exports.deepFreeze = function (o) {
  if (NODE_ENV === 'production') {
    return o
  }

  if (!o || typeof o !== 'object' || Object.isFrozen(o)) {
    return o
  }

  Object.freeze(o)

  Object
    .getOwnPropertyNames(o)
    .forEach(prop => module.exports.deepFreeze(o[prop]))

  return o
}

module.exports.splitRev = function (s) {
  if (!s) {
    return [ -1, '00000000000000' ]
  }

  const i = s.indexOf('-')
  const ver = s.slice(0, i)

  return [ ver === 'INF' ? Infinity : parseInt(ver, 10), s.slice(i + 1) ]
}

module.exports.isPlainObject = function (value) {
  if (
    typeof value != 'object' ||
    value == null ||
    Object.prototype.toString(value) != '[object Object]'
  ) {
    return false
  }
  if (Object.getPrototypeOf(value) === null) {
    return true
  }
  let proto = value
  while (Object.getPrototypeOf(proto) !== null) {
    proto = Object.getPrototypeOf(proto)
  }
  return Object.getPrototypeOf(value) === proto
}

module.exports.isSameOrNewer = function (a, b) {
  const [ av, ar ] = module.exports.splitRev(a)
  const [ bv, br ] = module.exports.splitRev(b)
  return av > bv || (av === bv && ar >= br)
}

module.exports.nextTick = function (fn) {
  if (module.exports.isNode) {
    process.nextTick(fn)
  } else {
    setTimeout(fn, 0)
  }
}

module.exports.shallowCopy = function (obj) {
  if (Array.isArray(obj)) {
    return obj.slice(0)
  }

  const copy = {}
  const props = Object.keys(obj)
  for (let i = 0; i < props.length; i++) {
    copy[props[i]] = obj[props[i]]
  }
  return copy
}

module.exports.setTimeout = function (callback, timeoutDuration) {
  if (timeoutDuration !== null) {
    return setTimeout(callback, timeoutDuration)
  } else {
    return -1
  }
}

module.exports.setInterval = function (callback, intervalDuration) {
  if (intervalDuration !== null) {
    return setInterval(callback, intervalDuration)
  } else {
    return -1
  }
}

module.exports.parseUrl = function (url, defaultPath) {
  if (unsupportedProtocol.test(url)) {
    throw new Error('Only ws and wss are supported')
  }
  if (!hasUrlProtocol.test(url)) {
    url = 'ws://' + url
  } else if (url.indexOf('//') === 0) {
    url = 'ws:' + url
  }
  const serverUrl = URL.parse(url)
  if (!serverUrl.host) {
    throw new Error('invalid url, missing host')
  }
  serverUrl.protocol = serverUrl.protocol ? serverUrl.protocol : 'ws:'
  serverUrl.pathname = serverUrl.pathname ? serverUrl.pathname : defaultPath
  return URL.format(serverUrl)
}
