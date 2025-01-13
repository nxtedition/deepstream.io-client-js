import type { Observable } from 'rxjs'
import Record from './record.js'

type Paths<T> = keyof T
type Get<Data, Path extends string> = Path extends keyof Data ? Data[Path] : unknown

export default class RecordHandler<Records> {
  VOID: 0
  CLIENT: 1
  SERVER: 2
  STALE: 3
  PROVIDER: 4

  JSON: {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    EMPTY: Readonly<{}>
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    EMPTY_OBJ: Readonly<{}>
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
    <Name extends keyof Records>(name: Name, data: Records[Name]): void

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
      updater: (data: Data) => Data,
    ): Promise<void>

    // with path:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data>>(
      name: Name,
      path: Path,
      updater: (data: Get<Data, Path>) => Get<Data, Path>,
    ): Promise<void>
  }

  observe: {
    // without path:
    <Name extends keyof Records, Data extends Records[Name]>(name: Name): Observable<Data>

    // with path:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data> & string>(
      name: Name,
      path: Path,
    ): Observable<Get<Data, Path>>

    // with state:
    <Name extends keyof Records, Data extends Records[Name]>(
      name: Name,
      state: number,
    ): Observable<Data>

    // with path and state:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data> & string>(
      name: Name,
      path: Path,
      state: number,
    ): Observable<Get<Data, Path>>
  }

  get: {
    // without path:
    <Name extends keyof Records, Data extends Records[Name]>(
      name: Name,
      state?: number,
    ): Promise<Data>

    // with path:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data> & string>(
      name: Name,
      path?: Path,
      state?: number,
    ): Promise<Get<Data, Path>>
  }

  observe2: {
    // without path:
    <Name extends keyof Records, Data extends Records[Name]>(
      name: Name,
    ): Observable<{
      name: Name
      version: string
      state: number
      data: Data
    }>

    // with path:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data> & string>(
      name: Name,
      path: Path,
    ): Observable<{
      name: Name
      version: Get<Data, Path>
      state: number
      data: Data
    }>

    // with state:
    <Name extends keyof Records, Data extends Records[Name]>(
      name: Name,
      state: number,
    ): Observable<{
      name: Name
      version: Get<Data, Path>
      state: number
      data: Data
    }>

    // with path and state:
    <Name extends keyof Records, Data extends Records[Name], Path extends Paths<Data> & string>(
      name: Name,
      path: Path,
      state: number,
    ): Observable<{
      name: Name
      version: Get<Data, Path>
      state: number
      data: Get<Data, Path>
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
