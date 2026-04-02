import type RecordHandler from './record-handler.js'
import type { Get as _Get, AllUnionFields } from 'type-fest'
export type { Paths } from 'type-fest'

// HACK: Wrap type-fest's Get to get rid of EmptyObject from union
type RemoveSymbolKeys<T> = {
  [K in keyof T as K extends symbol ? never : K]: T[K]
}
export type Get<BaseType, Path extends string | readonly string[]> = _Get<
  RemoveSymbolKeys<AllUnionFields<BaseType>>,
  Path
>

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
  [Symbol.dispose](): void
  subscribe(
    callback: (record: Record<Data>, opaque: unknown) => void,
    opaque?: unknown,
  ): Record<Data>
  unsubscribe(
    callback: (record: Record<Data>, opaque: unknown) => void,
    opaque?: unknown,
  ): Record<Data>

  get: {
    // with path
    <P extends string | string[]>(path: P): Get<Data, P>
    // with function mapper
    <R>(fn: (data: Data) => R): R
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
    (
      updater: (data: Readonly<Data>, version: string) => Data,
      options?: UpdateOptions,
    ): Promise<void>
    // with path
    <P extends string | string[]>(
      path: P,
      updater: (dataAtPath: Readonly<Get<Data, P>>, version: string) => Get<Data, P>,
      options?: UpdateOptions,
    ): Promise<void>
  }
}
