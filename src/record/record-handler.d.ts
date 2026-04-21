import type { Observable } from 'rxjs'
import type { RecordNameToType, RecordPathToType, RecordPathToWriteType } from './resolve-type.d.ts'
import type DsRecord from './record.js'
import type { UpdateOptions, ObserveOptions, ObserveOptionsWithPath } from './record.js'

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

  getRecord<Name extends string, Data = RecordNameToType<Records, Name>>(name: Name): DsRecord<Data>

  provide: (
    pattern: string,
    callback: (key: string) => unknown,
    optionsOrRecursive?: ProvideOptions | boolean,
  ) => Disposable

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
      | { value: RecordNameToType<Records, Name>; async: false }
      | { value: Promise<RecordNameToType<Records, Name>>; async: true }

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      options?: ObserveOptions,
    ):
      | { value: RecordPathToType<Records, Name, Path>; async: false }
      | { value: Promise<RecordPathToType<Records, Name, Path>>; async: true }

    <Name extends string>(
      name: Name,
      state?: number,
    ):
      | { value: RecordNameToType<Records, Name>; async: false }
      | { value: Promise<RecordNameToType<Records, Name>>; async: true }
  }

  sync: (options?: SyncOptions) => Promise<void>

  set: {
    // without path:
    <Name extends string>(name: Name, data: RecordNameToType<Records, Name>): void

    // with path:
    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      data: RecordPathToWriteType<Records, Name, Path>,
    ): void
  }

  update: {
    <Name extends string>(
      name: Name,
      updater: (
        data: RecordNameToType<Records, Name>,
        version: string,
      ) => RecordNameToType<Records, Name>,
      options?: UpdateOptions,
    ): Promise<void>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      updater: (
        data: RecordPathToType<Records, Name, Path>,
        version: string,
      ) => RecordPathToType<Records, Name, Path>,
      options?: UpdateOptions,
    ): Promise<void>
  }

  observe: {
    <Name extends string>(
      name: Name,
      options: ObserveOptions,
    ): Observable<RecordNameToType<Records, Name>>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      options: ObserveOptionsWithPath<Path>,
    ): Observable<RecordPathToType<Records, Name, Path>>

    <Name extends string>(
      name: Name,
      state?: number,
      options?: ObserveOptions,
    ): Observable<RecordNameToType<Records, Name>>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      state?: number,
      options?: ObserveOptionsWithPath<Path>,
    ): Observable<RecordPathToType<Records, Name, Path>>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      options?: ObserveOptionsWithPath<Path>,
    ): Observable<RecordPathToType<Records, Name, Path>>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      state?: number,
      options?: ObserveOptionsWithPath<Path>,
    ): Observable<RecordPathToType<Records, Name, Path>>
  }

  observe2: {
    <Name extends string>(
      name: Name,
      options: ObserveOptions,
    ): Observable<{
      name: string
      version: string
      state: number
      data: RecordNameToType<Records, Name>
    }>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      options: ObserveOptionsWithPath<Path>,
    ): Observable<{
      name: string
      version: string
      state: number
      data: RecordPathToType<Records, Name, Path>
    }>

    <Name extends string>(
      name: Name,
      state?: number,
      options?: ObserveOptions,
    ): Observable<{
      name: string
      version: string
      state: number
      data: RecordNameToType<Records, Name>
    }>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      state?: number,
      options?: ObserveOptionsWithPath<Path>,
    ): Observable<{
      name: string
      version: string
      state: number
      data: RecordPathToType<Records, Name, Path>
    }>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      options?: ObserveOptionsWithPath<Path>,
    ): Observable<{
      name: string
      version: string
      state: number
      data: RecordPathToType<Records, Name, Path>
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
      data: RecordPathToType<Records, Name, Path>
    }>
  }

  get: {
    <Name extends string>(
      name: Name,
      options: ObserveOptions,
    ): Promise<RecordNameToType<Records, Name>>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      options: ObserveOptionsWithPath<Path>,
    ): Promise<RecordPathToType<Records, Name, Path>>

    <Name extends string>(
      name: Name,
      state?: number,
      options?: ObserveOptions,
    ): Promise<RecordNameToType<Records, Name>>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      state?: number,
      options?: ObserveOptionsWithPath<Path>,
    ): Promise<RecordPathToType<Records, Name, Path>>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      options?: ObserveOptionsWithPath<Path>,
    ): Promise<RecordPathToType<Records, Name, Path>>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      state?: number,
      options?: ObserveOptionsWithPath<Path>,
    ): Promise<RecordPathToType<Records, Name, Path>>
  }

  get2: {
    <Name extends string>(
      name: Name,
      options: ObserveOptions,
    ): Promise<{
      name: string
      version: string
      state: number
      data: RecordNameToType<Records, Name>
    }>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      options: ObserveOptionsWithPath<Path>,
    ): Promise<{
      name: string
      version: string
      state: number
      data: RecordPathToType<Records, Name, Path>
    }>

    <Name extends string>(
      name: Name,
      state?: number,
      options?: ObserveOptions,
    ): Promise<{
      name: string
      version: string
      state: number
      data: RecordNameToType<Records, Name>
    }>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      state?: number,
      options?: ObserveOptionsWithPath<Path>,
    ): Promise<{
      name: string
      version: string
      state: number
      data: RecordPathToType<Records, Name, Path>
    }>

    <Name extends string, Path extends string | string[]>(
      name: Name,
      path: Path,
      options?: ObserveOptionsWithPath<Path>,
    ): Promise<{
      name: string
      version: string
      state: number
      data: RecordPathToType<Records, Name, Path>
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
      data: RecordPathToType<Records, Name, Path>
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
