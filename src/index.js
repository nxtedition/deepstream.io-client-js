const deepstream = require('./client')

const URL = 'ws://localhost:6020/deepstream'

const PARAMS = {
  maxReconnectAttempts: Infinity,
  maxReconnectInterval: 10000
}

const AUTH = {
  type: 'secret',
  username: `_search`,
  secret: '607fad56-8d89-43c2-90bb-f6de3bcc978d'
}

const ds = deepstream(URL, PARAMS)
  .login(AUTH, (success, authData) => {
    if (!success) {
      console.error({ authData }, 'Deepstream Authentication Failed. Shutting down...')
      process.exit(1)
    }
  })

ds.on('connectionStateChanged', connectionState => {
  console.log({ connectionState }, 'Deepstream Connection State Changed.')
})

ds.on('error', (error, event, topic) => {
  console.error({ error, event, topic }, 'Deepstream Error.')
  process.exit(2)
})

setTimeout(() => {
  console.log('CLOSE')
  ds.close()
}, 3000)
