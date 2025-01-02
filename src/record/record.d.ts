import RecordHandler from './record-handler.js'

type Paths<T> = keyof T
type Get<Data, Path extends string> = Path extends keyof Data ? Data[Path] : unknown

export interface WhenOptions {
  state?: number
  timeout?: number
  signal?: AbortSignal
}

export interface UpdateOptions {
  signal?: AbortSignal
}

export default class Record<Data> {
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
    <Path extends Paths<Data>, DataAtPath extends Get<Data, Path> = Get<Data, Path>>(
      path: Path,
    ): DataAtPath
    // without path
    (): Data
    // implementation
    <Path extends Paths<Data>, DataAtPath extends Get<Data, Path> = Get<Data, Path>>(
      path?: Path,
    ): Path extends undefined ? Data : DataAtPath
  }

  set: {
    // with path
    <Path extends Paths<Data>, DataAtPath extends Get<Data, Path>>(
      path: Path,
      dataAtPath: DataAtPath,
    ): void
    // without path
    (data: Data): void
    // implementation
    <Path extends Paths<Data>, DataAtPath extends Get<Data, Path>>(
      ...args: [pathOrData: Path | Data, value?: DataAtPath]
    ): void
  }

  when: {
    (): Promise<Record<Data>>
    (state: number): Promise<Record<Data>>
    (options: WhenOptions): Promise<Record<Data>>
    (state: number, options: WhenOptions): Promise<Record<Data>>
  }

  update<Path extends Paths<Data>, PathOrUpdater extends Path | ((data: Data) => Data)>(
    ...args: PathOrUpdater extends Path
      ? [
          path: Path,
          updater: (dataAtPath: Get<Data, Path>) => Get<Data, Path>,
          options?: UpdateOptions,
        ]
      : [updater: PathOrUpdater, options?: UpdateOptions]
  ): Promise<void>
}
