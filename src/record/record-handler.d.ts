import type { Observable } from 'rxjs'
import type Record, { EmptyObject, GettablePossibleEmpty, SettablePossibleEmpty } from './record.js'

type Paths<T> = keyof T
type Get<Data, Path extends string> = Path extends keyof Data ? Data[Path] : unknown

export default class RecordHandler<Records> {
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

  getRecord: <Name extends keyof Records, Data extends Records[Name] = Records[Name]>(
    name: Name,
  ) => Record<Data>

  provide: <Data>(
    pattern: string,
    callback: (key: string) => Data,
    optionsOrRecursive?: ProvideOptions | boolean,
  ) => void | (() => void)

  sync: (options?: SyncOptions) => Promise<void>

  set: {
    // without path:
    <Name extends keyof Records>(name: Name, data: SettablePossibleEmpty<Records[Name]>): void

    // with path:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data>>(
      name: Name,
      path: Path,
      data: Get<Data, Path>,
    ): void
  }

  update: {
    // without path:
    <Name extends keyof Records, Data extends Records[Name]>(
      name: Name,
      updater: (data: Readonly<GettablePossibleEmpty<Data>>) => SettablePossibleEmpty<Data>,
    ): Promise<void>

    // with path:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data>>(
      name: Name,
      path: Path,
      updater: (data: Readonly<Get<Data, Path>> | undefined) => Get<Data, Path>,
    ): Promise<void>
  }

  observe: {
    // without path:
    <Name extends keyof Records, Data extends Records[Name]>(
      name: Name,
    ): Observable<GettablePossibleEmpty<Data>>

    // with path:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data> & string>(
      name: Name,
      path: Path,
    ): Observable<Get<Data, Path> | undefined>

    // with state:
    <Name extends keyof Records, Data extends Records[Name]>(
      name: Name,
      state: number,
    ): Observable<GettablePossibleEmpty<Data>>

    // with path and state:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data> & string>(
      name: Name,
      path: Path,
      state: number,
    ): Observable<Get<Data, Path> | undefined>
  }

  get: {
    // without path:
    <Name extends keyof Records, Data extends Records[Name]>(
      name: Name,
      state?: number,
    ): Promise<GettablePossibleEmpty<Data>>

    // with path:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data> & string>(
      name: Name,
      path?: Path,
      state?: number,
    ): Promise<Get<Data, Path> | undefined>
  }

  observe2: {
    // without path:
    <Name extends keyof Records, Data extends Records[Name]>(
      name: Name,
    ): Observable<{
      name: Name
      version: string
      state: number
      data: GettablePossibleEmpty<Data>
    }>

    // with path:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data> & string>(
      name: Name,
      path: Path,
    ): Observable<{
      name: Name
      version: string
      state: number
      data: Get<Data, Path> | undefined
    }>

    // with state:
    <Name extends keyof Records, Data extends Records[Name]>(
      name: Name,
      state: number,
    ): Observable<{
      name: Name
      version: string
      state: number
      data: GettablePossibleEmpty<Data>
    }>

    // with path and state:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data> & string>(
      name: Name,
      path: Path,
      state: number,
    ): Observable<{
      name: Name
      version: string
      state: number
      data: Get<Data, Path> | undefined
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
