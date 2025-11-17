import type { Observable } from 'rxjs'
import type DsRecord from './record.js'
import type {
  EmptyObject,
  Get,
  UpdateOptions,
  ObserveOptions,
  ObserveOptionsWithPath,
} from './record.js'

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
    EMPTY_ARR: []
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
    <Name extends string>(
      name: Name,
      updater: (data: Lookup<Records, Name>) => Lookup<Records, Name> | EmptyObject,
      options?: UpdateOptions,
    ): Promise<void>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      updater: (data: Get<Lookup<Records, Name>, Path>) => Get<Lookup<Records, Name>, Path>,
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
