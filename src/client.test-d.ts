import make from './client.js'
import { expectAssignable, expectError } from 'tsd'

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

expectAssignable<string>(await ds.record.get(`${id}:domain`, 'd2.d3'))

// errors
expectError(ds.record.set('o', 'o0.o1', { o2: { o3: 0 } }))
expectError(ds.record.set('o', 'o0.o1', { o3: 0 }))
expectError(ds.record.set('n', 'x1', {}))
expectError(ds.record.set('n', 'n0.x2', 22))
expectError(ds.record.set('n', 'n1.x2', {}))
expectError(ds.record.set('n', 'n1.n2.n3', { n4: 22 }))

expectAssignable<string>(await ds.record.get('p', 'p1'))
expectAssignable<string | undefined>(await ds.record.get('p', 'p2'))
expectAssignable<unknown>(await ds.record.get('p', 'x1'))

// Circular
expectAssignable<string | undefined>(await ds.record.get('c', 'a.b1'))

// ============
//

// getRecord
const daRec = ds.record.getRecord('o')
daRec.set({ o0: {} })

daRec.update('o0', (x) => ({ ...x, o1: {} }))
expectError(daRec.update((x) => 'x'))
expectError(daRec.update('o0', (x) => ({ ...x, o1: '22' })))

ds.record.set('foo', { num: [22, true] })
ds.record.set('foo', { num: ['22'] })
