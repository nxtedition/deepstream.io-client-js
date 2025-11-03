import make from './client.js'
import { expectAssignable, expectError } from 'tsd'
import type { Observable } from 'rxjs'

interface Records extends Record<string, unknown> {
  o: {
    o0?: {
      o1?: {
        o2?: {
          o3?: string
        }
      }
    }
  }
  n: {
    n0: {
      n1: {
        n2: {
          n3: string
        }
      }
    }
  }
  c: Circular
  m: {
    m1: string
    m2: string
    m3?: string
  }
  p: {
    p1: string
    p2?: string
    p3: { p4: string }
  }
  [x: `${string}:domain`]: {
    d1: string
    d2: {
      d3: string
    }
  }
}

interface Circular {
  a: {
    b0: Circular
    b1: string
  }
}

const ds = make<Records>('')

expectAssignable<{ n0?: { n1: { n2: { n3: string } } } } | undefined>(await ds.record.get('n'))
expectAssignable<{ n1: { n2: { n3: string } } } | undefined>(await ds.record.get('n', 'n0'))

// set withouth path
ds.record.set('n', {}) // empty should always work
ds.record.set('n', { n0: { n1: { n2: { n3: 'test' } } } })
expectError(ds.record.set('n', { n0: {} })) // nested props are required

// set with path
ds.record.set('n', 'n0.n1', { n2: { n3: 'test' } })
ds.record.set('n', 'n0', { n1: { n2: { n3: 'test' } } })
ds.record.set('n', 'n0.n1', { n2: { n3: 'test' } })
ds.record.set('n', 'n0.n1.n2', { n3: 'test' })
ds.record.set('n', 'n0.n1.n2.n3', 'test')
ds.record.set('o', 'o0.o1.o2.o3', 'test')
ds.record.set('o', 'o0', {})
ds.record.set('o', 'o0.o1', {})
ds.record.set('o', 'o0.o1.o2', {})
ds.record.set('o', 'o0.o1', { o2: {} })
ds.record.set('o', 'o0.o1', { o2: { o3: 'test' } })
ds.record.set('c', 'a.b1', 'test')
ds.record.set('x:domain', 'd1', 'test')
const id = 'id'
ds.record.set(`${id}:domain`, 'd2.d3', 'test')
expectError(ds.record.set(`${id}:domain`, 'd2.d3', 22))
ds.record.set(`${id}:domain`, ['d2', 'd3'] as const, 'test')

expectAssignable<string>(await ds.record.get(`${id}:domain`, 'd2.d3'))

// errors
expectError(ds.record.set('o', 'o0.o1', { o2: { o3: 0 } }))
expectError(ds.record.set('o', 'o0.o1', { o3: 0 }))
expectError(ds.record.set('n', 'x1', {}))
expectError(ds.record.set('n', 'n0.x2', 22))
expectError(ds.record.set('n', 'n1.x2', {}))
expectError(ds.record.set('n', 'n1.n2.n3', { n4: 22 }))

expectAssignable<string>(await ds.record.get('p', 'p1'))
expectAssignable<string>(await ds.record.get('p', 'p1', { signal: new AbortController().signal }))
expectAssignable<string>(await ds.record.get('p', { path: 'p1' }))
expectAssignable<string | undefined>(await ds.record.get('p', 'p2'))
expectAssignable<unknown>(await ds.record.get('p', 'x1'))

// observe with options
expectAssignable<Observable<{ p1: string; p2?: string; p3: { p4: string } }>>(
  ds.record.observe('p', { signal: new AbortController().signal }),
)
expectAssignable<Observable<{ p1: string; p2?: string; p3: { p4: string } }>>(
  ds.record.observe('p', { timeout: 5000 }),
)
expectAssignable<Observable<string>>(
  ds.record.observe('p', 'p1', { signal: new AbortController().signal }),
)
expectAssignable<Observable<string>>(ds.record.observe('p', { path: 'p1', timeout: 5000 }))
expectAssignable<Observable<string>>(
  ds.record.observe('p', 'p1', 2, { signal: new AbortController().signal }),
)
expectAssignable<Observable<{ p1: string; p2?: string; p3: { p4: string } }>>(
  ds.record.observe('p', 2, { timeout: 5000 }),
)

// observe2 with options
expectAssignable<
  Observable<{
    name: string
    version: string
    state: number
    data: { p1: string; p2?: string; p3: { p4: string } }
  }>
>(ds.record.observe2('p', { signal: new AbortController().signal }))
expectAssignable<
  Observable<{
    name: string
    version: string
    state: number
    data: { p1: string; p2?: string; p3: { p4: string } }
  }>
>(ds.record.observe2('p', { timeout: 5000 }))
expectAssignable<
  Observable<{
    name: string
    version: string
    state: number
    data: string
  }>
>(ds.record.observe2('p', 'p1', { signal: new AbortController().signal }))
expectAssignable<
  Observable<{
    name: string
    version: string
    state: number
    data: string
  }>
>(ds.record.observe2('p', { path: 'p1', timeout: 5000 }))
expectAssignable<
  Observable<{
    name: string
    version: string
    state: number
    data: string
  }>
>(ds.record.observe2('p', 'p1', 2, { signal: new AbortController().signal }))
expectAssignable<
  Observable<{
    name: string
    version: string
    state: number
    data: { p1: string; p2?: string; p3: { p4: string } }
  }>
>(ds.record.observe2('p', 2, { timeout: 5000 }))

// update with options
expectAssignable<Promise<void>>(
  ds.record.update('p', (data) => data, { signal: new AbortController().signal }),
)
expectAssignable<Promise<void>>(ds.record.update('p', (data) => data, { timeout: 5000 }))
expectAssignable<Promise<void>>(
  ds.record.update('p', 'p1', (data) => data, { signal: new AbortController().signal }),
)
expectAssignable<Promise<void>>(ds.record.update('p', 'p1', (data) => data, { timeout: 5000 }))

// Circular
expectAssignable<string | undefined>(await ds.record.get('c', 'a.b1'))

// ============
//

// getRecord
const rec = ds.record.getRecord('o')
rec.set({ o0: {} })

rec.update('o0', (x) => ({ ...x, o1: {} }))
expectError(rec.set('o0.x1', {}))
rec.set('o0.o1', {})
expectError(rec.update((x) => 'x'))
expectError(rec.update('o0', (x) => ({ ...x, o1: '22' })))

// when with options
expectAssignable<Promise<typeof rec>>(rec.when())
expectAssignable<Promise<typeof rec>>(rec.when(2))
expectAssignable<Promise<typeof rec>>(rec.when({ timeout: 5000 }))
expectAssignable<Promise<typeof rec>>(rec.when({ signal: new AbortController().signal }))
expectAssignable<Promise<typeof rec>>(rec.when({ state: 2 }))
expectAssignable<Promise<typeof rec>>(rec.when({ state: 2, timeout: 5000 }))
expectAssignable<Promise<typeof rec>>(rec.when(2, { timeout: 5000 }))
expectAssignable<Promise<typeof rec>>(rec.when(2, { signal: new AbortController().signal }))

// Record.update with options
expectAssignable<Promise<void>>(rec.update((x) => x, { signal: new AbortController().signal }))
expectAssignable<Promise<void>>(rec.update((x) => x, { timeout: 5000 }))
expectAssignable<Promise<void>>(rec.update((x) => x, { state: 2 }))
expectAssignable<Promise<void>>(
  rec.update('o0', (x) => x, { signal: new AbortController().signal }),
)
expectAssignable<Promise<void>>(rec.update('o0', (x) => x, { timeout: 5000 }))
expectAssignable<Promise<void>>(rec.update('o0', (x) => x, { state: 2 }))
