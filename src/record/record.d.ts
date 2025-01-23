import type RecordHandler from './record-handler.js'
import type { EmptyObject, SingleKeyObject } from 'type-fest'

type Paths<T> = keyof T
type Get<Data, Path extends string> = Path extends keyof Data ? Data[Path] : unknown

export type { EmptyObject } from 'type-fest'

// When getting, for convenience, we say the data might be partial under some
// circumstances.
//
// When you e.g. do record.get or record.update, there is always a possibility
// that the data object is empty. The naive correct type for that would be
// `Data | EmptyObject`. However, that forces the user to always type guard
// against the empty object case. This type tries to allow the user to skip
// that check in some cases, where it should be safe to do so.
export type GettablePossibleEmpty<Data> = keyof Data extends never
  ? EmptyObject // If there are no keys at all
  : Partial<Data> extends Data
    ? // All properties in Data are already optional, so we can safely return it
      // as is. The user just need to check the properties themselves instead.
      Data
    : SingleKeyObject<Data> extends never
      ? // There are more than one property in Data, and some of them are
        // required. That means that the user must always check for the empty
        // object case.
        Data | EmptyObject
      : // There is exactly one property in Data, and it is required. In this
        // particular case, we can safely use Data as the "empty" type, but
        // with the single property turned optional.
        {
          [K in keyof Data]+?: Data[K]
        }

// When setting the data must fully adhere to the Data type, or exactly an
// empty object.
export type SettablePossibleEmpty<Data> = Data | EmptyObject

export interface WhenOptions {
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
  readonly data: GettablePossibleEmpty<Data>
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
    ): DataAtPath | undefined
    // without path
    (): GettablePossibleEmpty<Data>
    // implementation
    <Path extends Paths<Data>, DataAtPath extends Get<Data, Path> = Get<Data, Path>>(
      path?: Path,
    ): Path extends undefined ? GettablePossibleEmpty<Data> : DataAtPath | undefined
  }

  set: {
    // with path
    <Path extends Paths<Data>, DataAtPath extends Get<Data, Path>>(
      path: Path,
      dataAtPath: DataAtPath,
    ): void
    // without path
    (data: SettablePossibleEmpty<Data>): void
    // implementation
    <Path extends Paths<Data>, DataAtPath extends Get<Data, Path>>(
      ...args: [pathOrData: Path | SettablePossibleEmpty<Data>, value?: DataAtPath]
    ): void
  }

  when: {
    (): Promise<Record<Data>>
    (state: number): Promise<Record<Data>>
    (options: WhenOptions): Promise<Record<Data>>
    (state: number, options: WhenOptions): Promise<Record<Data>>
  }

  update<
    Path extends Paths<Data>,
    PathOrUpdater extends
      | Path
      | ((data: Readonly<GettablePossibleEmpty<Data>>) => SettablePossibleEmpty<Data>),
  >(
    ...args: PathOrUpdater extends Path
      ? [
          path: Path,
          updater: (dataAtPath: Readonly<Get<Data, Path>> | undefined) => Get<Data, Path>,
          options?: UpdateOptions,
        ]
      : [updater: PathOrUpdater, options?: UpdateOptions]
  ): Promise<void>
}
