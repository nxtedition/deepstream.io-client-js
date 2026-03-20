import make from '../client.js'
import { expectAssignable, expectError, expectType } from 'tsd'

interface Methods extends Record<string, [unknown, unknown]> {
  greet: [{ name: string }, { message: string }]
}

const ds = make<Record<string, unknown>, Methods>('')

// provide: callback may return void, a value, or a Promise — all valid
ds.rpc.provide('greet', (_args, _response) => {})
ds.rpc.provide('greet', (_args, _response) => ({ message: 'hello' }))
ds.rpc.provide('greet', async (_args, _response) => ({ message: 'hello' }))
// async callback that uses response.send() directly — returns Promise<void>
ds.rpc.provide('greet', async (_args, response) => {
  response.send({ message: 'hello' })
})

// provide: returning the wrong shape is an error
expectError(ds.rpc.provide('greet', (_args, _response) => ({ notMessage: 'hello' })))

// provide: response.completed is boolean
ds.rpc.provide('greet', (_args, response) => {
  expectType<boolean>(response.completed)
})

// provide: return type is UnprovideFn | void
expectAssignable<(() => void) | void>(ds.rpc.provide('greet', () => {}))

// make: args is optional (no args)
expectAssignable<Promise<{ message: string }>>(ds.rpc.make('greet'))
// make: args provided
expectAssignable<Promise<{ message: string }>>(ds.rpc.make('greet', { name: 'world' }))
// make: args explicitly undefined
expectAssignable<Promise<{ message: string }>>(ds.rpc.make('greet', undefined))
// make: callback form — args required positionally but can be undefined
ds.rpc.make('greet', undefined, (err, res) => {
  expectType<unknown>(err)
  expectAssignable<{ message: string } | undefined>(res)
})
