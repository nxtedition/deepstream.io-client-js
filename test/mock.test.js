import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as rxjs from 'rxjs'
import { MockDeepstreamClient } from '../src/mock/index.ts'

describe('MockRecord.set', () => {
  it('sets the whole record data', () => {
    const { client } = MockDeepstreamClient.create()
    client.record.set('rec1', { type: 'file', title: 'a' })
    assert.deepEqual(client.record.getRecord('rec1').get(), { type: 'file', title: 'a' })
  })

  it('sets a path', () => {
    const { client } = MockDeepstreamClient.create()
    client.record.set('rec1', { type: 'file' })
    client.record.set('rec1', 'title', 'b')
    assert.equal(client.record.getRecord('rec1').get('type'), 'file')
    assert.equal(client.record.getRecord('rec1').get('title'), 'b')
  })

  it('clears a path on set(name, path, undefined) instead of replacing the data', () => {
    const { client } = MockDeepstreamClient.create()
    client.record.set('rec1', { type: 'file', error: { message: 'boom' } })
    // The real client disambiguates on argument count, so this clears the
    // error path; it must not turn the record data into the string 'error'.
    client.record.set('rec1', 'error', undefined)
    const record = client.record.getRecord('rec1')
    assert.equal(record.get('type'), 'file')
    assert.equal(record.get('error'), undefined)
    assert.equal(typeof record.get(), 'object')
  })
})

describe('MockRecordHandler.provide', () => {
  it('flattens providers that emit observables, like the real provider infrastructure', async () => {
    const { client } = MockDeepstreamClient.create()
    // A common provider shape: an outer observe mapped to an inner pipeline.
    client.record.provide(':stats[?]$', () => rxjs.of(rxjs.of({ status: 'ok' })))

    const value = await rxjs.firstValueFrom(
      client.record.observe('rec1:stats?').pipe(rxjs.timeout(1000)),
    )
    assert.deepEqual(value, { status: 'ok' })
  })

  it('switches to the latest inner observable across outer emissions', async () => {
    const { client } = MockDeepstreamClient.create()
    const outer$ = new rxjs.BehaviorSubject(rxjs.of({ status: 'first' }))
    client.record.provide(':stats[?]$', () => outer$)

    const values = []
    const sub = client.record.observe('rec1:stats?').subscribe((value) => values.push(value))
    outer$.next(rxjs.of({ status: 'second' }))
    sub.unsubscribe()

    assert.deepEqual(values, [{ status: 'first' }, { status: 'second' }])
  })

  it('keeps plain value providers working', async () => {
    const { client } = MockDeepstreamClient.create()
    client.record.provide(':stats[?]$', () => ({ status: 'plain' }))

    const value = await rxjs.firstValueFrom(
      client.record.observe('rec1:stats?').pipe(rxjs.timeout(1000)),
    )
    assert.deepEqual(value, { status: 'plain' })
  })
})
