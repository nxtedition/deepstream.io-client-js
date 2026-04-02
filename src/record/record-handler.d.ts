import type { Observable } from 'rxjs'
import type DsRecord from './record.js'
import type { Get, UpdateOptions, ObserveOptions, ObserveOptionsWithPath } from './record.js'

type Lookup<Table, Name> = Name extends keyof Table ? Table[Name] : unknown

type Disposer = {
  (): void
  [Symbol.dispose](): void
}

export default class RecordHandler<Records = Record<string, unknown>> {
  VOID: 0
  CLIENT: 1
  SERVER: 2
  STALE: 3
  PROVIDER: 4

  STATE: {
    VOID: 0
    CLIENT: 1
    SERVER: 2
    STALE: 3
    PROVIDER: 4
    [key: string]: number
  }

  JSON: {
    EMPTY: Record<string, unknown>
    EMPTY_OBJ: Record<string, unknown>
    EMPTY_ARR: []
  }

  connected: boolean
  stats: RecordStats

  getRecord<Name extends string, Data = Lookup<Records, Name>>(name: Name): DsRecord<Data>

  provide: (
    pattern: string,
    callback: (key: string) => unknown,
    optionsOrRecursive?: ProvideOptions | boolean,
  ) => Disposer | void

  put: (
    name: string,
    version: string,
    data: Record<string, unknown> | null,
    parent?: string,
  ) => void

  getAsync: {
    <Name extends string>(
      name: Name,
      options: ObserveOptions,
    ):
      | { value: Lookup<Records, Name>; async: false }
      | { value: Promise<Lookup<Records, Name>>; async: true }

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      options?: ObserveOptions,
    ):
      | { value: Get<Lookup<Records, Name>, Path>; async: false }
      | { value: Promise<Get<Lookup<Records, Name>, Path>>; async: true }

    <Name extends string>(
      name: Name,
      state?: number,
    ):
      | { value: Lookup<Records, Name>; async: false }
      | { value: Promise<Lookup<Records, Name>>; async: true }
  }

  sync: (options?: SyncOptions) => Promise<void>

  set: {
    // without path:
    <Name extends string>(name: Name, data: Lookup<Records, Name>): void

    // with path:
    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      data: unknown extends Get<Lookup<Records, Name>, Path>
        ? never
        : Get<Lookup<Records, Name>, Path>,
    ): void
  }

  update: {
    <Name extends string>(
      name: Name,
      updater: (data: Lookup<Records, Name>, version: string) => Lookup<Records, Name>,
      options?: UpdateOptions,
    ): Promise<void>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      updater: (
        data: Get<Lookup<Records, Name>, Path>,
        version: string,
      ) => Get<Lookup<Records, Name>, Path>,
      options?: UpdateOptions,
    ): Promise<void>
  }

  observe: {
    <Name extends string>(name: Name, options: ObserveOptions): Observable<Lookup<Records, Name>>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      options: ObserveOptionsWithPath<Path>,
    ): Observable<Get<Lookup<Records, Name>, Path>>

    <Name extends string>(
      name: Name,
      state?: number,
      options?: ObserveOptions,
    ): Observable<Lookup<Records, Name>>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      state?: number,
      options?: ObserveOptionsWithPath<Path>,
    ): Observable<Get<Lookup<Records, Name>, Path>>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      options?: ObserveOptionsWithPath<Path>,
    ): Observable<Get<Lookup<Records, Name>, Path>>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      state?: number,
      options?: ObserveOptionsWithPath<Path>,
    ): Observable<Get<Lookup<Records, Name>, Path>>
  }

  observe2: {
    <Name extends string>(
      name: Name,
      options: ObserveOptions,
    ): Observable<{
      name: string
      version: string
      state: number
      data: Lookup<Records, Name>
    }>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      options: ObserveOptionsWithPath<Path>,
    ): Observable<{
      name: string
      version: string
      state: number
      data: Get<Lookup<Records, Name>, Path>
    }>

    <Name extends string>(
      name: Name,
      state?: number,
      options?: ObserveOptions,
    ): Observable<{
      name: string
      version: string
      state: number
      data: Lookup<Records, Name>
    }>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      state?: number,
      options?: ObserveOptionsWithPath<Path>,
    ): Observable<{
      name: string
      version: string
      state: number
      data: Get<Lookup<Records, Name>, Path>
    }>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      options?: ObserveOptionsWithPath<Path>,
    ): Observable<{
      name: string
      version: string
      state: number
      data: Get<Lookup<Records, Name>, Path>
    }>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      state?: number,
      options?: ObserveOptionsWithPath<Path>,
    ): Observable<{
      name: string
      version: string
      state: number
      data: Get<Lookup<Records, Name>, Path>
    }>
  }

  get: {
    <Name extends string>(name: Name, options: ObserveOptions): Promise<Lookup<Records, Name>>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      options: ObserveOptionsWithPath<Path>,
    ): Promise<Get<Lookup<Records, Name>, Path>>

    <Name extends string>(
      name: Name,
      state?: number,
      options?: ObserveOptions,
    ): Promise<Lookup<Records, Name>>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      state?: number,
      options?: ObserveOptionsWithPath<Path>,
    ): Promise<Get<Lookup<Records, Name>, Path>>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      options?: ObserveOptionsWithPath<Path>,
    ): Promise<Get<Lookup<Records, Name>, Path>>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      state?: number,
      options?: ObserveOptionsWithPath<Path>,
    ): Promise<Get<Lookup<Records, Name>, Path>>
  }

  get2: {
    <Name extends string>(
      name: Name,
      options: ObserveOptions,
    ): Promise<{
      name: string
      version: string
      state: number
      data: Lookup<Records, Name>
    }>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      options: ObserveOptionsWithPath<Path>,
    ): Promise<{
      name: string
      version: string
      state: number
      data: Get<Lookup<Records, Name>, Path>
    }>

    <Name extends string>(
      name: Name,
      state?: number,
      options?: ObserveOptions,
    ): Promise<{
      name: string
      version: string
      state: number
      data: Lookup<Records, Name>
    }>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      state?: number,
      options?: ObserveOptionsWithPath<Path>,
    ): Promise<{
      name: string
      version: string
      state: number
      data: Get<Lookup<Records, Name>, Path>
    }>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      options?: ObserveOptionsWithPath<Path>,
    ): Promise<{
      name: string
      version: string
      state: number
      data: Get<Lookup<Records, Name>, Path>
    }>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      state?: number,
      options?: ObserveOptionsWithPath<Path>,
    ): Promise<{
      name: string
      version: string
      state: number
      data: Get<Lookup<Records, Name>, Path>
    }>
  }
}

export interface RecordStats {
  updating: number
  created: number
  destroyed: number
  records: number
  pruning: number
  patching: number
  subscriptions: number
  listeners: number
}

export interface ProvideOptions {
  recursive?: boolean
  stringify?: ((input: unknown) => string) | null
  mode?: null | 'unicast' | (string & {})
}

export interface SyncOptions {
  signal?: AbortSignal
  timeout?: number
}
