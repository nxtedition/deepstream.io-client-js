import type { Observable } from 'rxjs'
import type DsRecord from './record.js'
import type { EmptyObject, Get, Paths } from './record.js'

export default class RecordHandler<
  Lookup extends Record<string, unknown> = Record<string, unknown>,
> {
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

  getRecord<Name extends string, Data = Name extends keyof Lookup ? Lookup[Name] : unknown>(
    name: Name,
  ): DsRecord<Data>

  provide: (
    pattern: string,
    callback: (key: string) => unknown,
    optionsOrRecursive?: ProvideOptions | boolean,
  ) => void | (() => void)

  sync: (options?: SyncOptions) => Promise<void>

  set: {
    // without path:
    <Name extends string>(name: Name, data: Lookup[Name] | EmptyObject): void

    // with path:
    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      data: Path extends Paths<Lookup[Name]> ? Get<Lookup[Name], Path> : never,
    ): void
  }

  update: {
    // without path:
    <Name extends string>(
      name: Name,
      updater: (data: Lookup[Name]) => Lookup[Name] | EmptyObject,
    ): Promise<void>

    // with path:
    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      updater: (data: Get<Lookup[Name], Path>) => Get<Lookup[Name], Path>,
    ): Promise<void>
  }

  observe: {
    // without path:
    <Name extends string>(name: Name): Observable<Lookup[Name]>

    // with path:
    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
    ): Observable<Get<Lookup[Name], Path>>

    // with state:
    <Name extends string>(name: Name, state: number): Observable<Lookup[Name]>

    // with path and state:
    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      state: number,
    ): Observable<Get<Lookup[Name], Path>>
  }

  get: {
    // without path:
    <Name extends string>(name: Name, state?: number): Promise<Lookup[Name]>

    // with path:
    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      state?: number,
    ): Promise<Get<Lookup[Name], Path>>
  }

  observe2: {
    // without path:
    <Name extends string>(
      name: Name,
    ): Observable<{
      name: string
      version: string
      state: number
      data: Lookup[Name]
    }>

    // with path:
    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
    ): Observable<{
      name: string
      version: string
      state: number
      data: Get<Lookup[Name], Path>
    }>

    // with state:
    <Name extends string>(
      name: Name,
      state: number,
    ): Observable<{
      name: string
      version: string
      state: number
      data: Lookup[Name]
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
      data: Get<Lookup[Name], Path>
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
