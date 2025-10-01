import type { Observable } from 'rxjs'
import type DsRecord from './record.js'
import type { EmptyObject, Get } from './record.js'

type Lookup<Table, Name> = Name extends keyof Table ? Table[Name] : unknown

export default class RecordHandler<Records = Record<string, unknown>> {
  VOID: 0
  CLIENT: 1
  SERVER: 2
  STALE: 3
  PROVIDER: 4

  JSON: {
    EMPTY: EmptyObject
    EMPTY_OBJ: EmptyObject
    EMPTY_ARR: Readonly<unknown[]>
  }

  connected: boolean
  stats: RecordStats

  getRecord<Name extends string, Data = Lookup<Records, Name>>(name: Name): DsRecord<Data>

  provide: (
    pattern: string,
    callback: (key: string) => unknown,
    optionsOrRecursive?: ProvideOptions | boolean,
  ) => void | (() => void)

  sync: (options?: SyncOptions) => Promise<void>

  set: {
    // without path:
    <Name extends string>(name: Name, data: Lookup<Records, Name> | EmptyObject): void

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
    // without path:
    <Name extends string>(
      name: Name,
      updater: (data: Lookup<Records, Name>) => Lookup<Records, Name> | EmptyObject,
    ): Promise<void>

    // with path:
    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      updater: (data: Get<Lookup<Records, Name>, Path>) => Get<Lookup<Records, Name>, Path>,
    ): Promise<void>
  }

  observe: {
    // without path:
    <Name extends string>(name: Name): Observable<Lookup<Records, Name>>

    // with path:
    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
    ): Observable<Get<Lookup<Records, Name>, Path>>

    // with state:
    <Name extends string>(name: Name, state: number): Observable<Lookup<Records, Name>>

    // with path and state:
    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      state: number,
    ): Observable<Get<Lookup<Records, Name>, Path>>
  }

  get: {
    // without path:
    <Name extends string>(name: Name, state?: number): Promise<Lookup<Records, Name>>

    // with path:
    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      state?: number,
    ): Promise<Get<Lookup<Records, Name>, Path>>
  }

  observe2: {
    // without path:
    <Name extends string>(
      name: Name,
    ): Observable<{
      name: string
      version: string
      state: number
      data: Lookup<Records, Name>
    }>

    // with path:
    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
    ): Observable<{
      name: string
      version: string
      state: number
      data: Get<Lookup<Records, Name>, Path>
    }>

    // with state:
    <Name extends string>(
      name: Name,
      state: number,
    ): Observable<{
      name: string
      version: string
      state: number
      data: Lookup<Records, Name>
    }>

    // with path and state:
    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      state: number,
    ): Observable<{
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
}

export interface ProvideOptions {
  recursive?: boolean
  stringify?: ((input: unknown) => string) | null
}

export interface SyncOptions {
  signal?: AbortSignal
  timeout?: number
}
