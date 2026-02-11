import type RecordHandler from './record-handler.js'
import type { Get } from 'type-fest'
export type { Get, Paths } from 'type-fest'

export interface WhenOptions {
  signal?: AbortSignal
  timeout?: number
  state?: number
}

export interface UpdateOptions {
  signal?: AbortSignal
  timeout?: number
  state?: number
}

export interface ObserveOptions {
  key?: string
  signal?: AbortSignal
  timeout?: number
  state?: number
  dataOnly?: boolean
  sync?: boolean
}

export interface ObserveOptionsWithPath<Path extends string | string[]> extends ObserveOptions {
  path?: Path
}

export default class Record<Data = unknown> {
  constructor(name: string, handler: RecordHandler)

  readonly name: string
  readonly version: string
  readonly data: Data
  readonly state: number
  readonly refs: number

  ref(): Record<Data>
  unref(): Record<Data>
  subscribe(callback: (record: Record<Data>) => void, opaque?: unknown): Record<Data>
  unsubscribe(callback: (record: Record<Data>) => void, opaque?: unknown): Record<Data>

  get: {
    // with path
    <P extends string | string[]>(path: P): Get<Data, P>
    // without path
    (): Data
    (path: undefined | string | string[]): unknown
  }

  set: {
    // with path
    <P extends string | readonly string[]>(
      path: P,
      dataAtPath: unknown extends Get<Data, P> ? never : Get<Data, P>,
    ): void
    // without path
    (data: Data): void
  }

  when: {
    (): Promise<Record<Data>>
    (options: WhenOptions): Promise<Record<Data>>
    (state: number, options?: WhenOptions): Promise<Record<Data>>
  }

  update: {
    // without path
    (updater: (data: Readonly<Data>) => Data, options?: UpdateOptions): Promise<void>
    // with path
    <P extends string | string[]>(
      path: P,
      updater: (dataAtPath: Readonly<Get<Data, P>>) => Get<Data, P>,
      options?: UpdateOptions,
    ): Promise<void>
  }
}
