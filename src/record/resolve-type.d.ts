import type { Get, SingleKeyObject } from 'type-fest'

declare const emptyObjectSymbol: unique symbol
export type EmptyObject = { [emptyObjectSymbol]?: never }

// When getting, for convenience, we say the data might be partial under some
// circumstances.
//
// When you e.g. do record.get or record.update, there is always a possibility
// that the data object is empty. The naive correct type for that would be
// `Data | EmptyObject`. However, that forces the user to always type guard
// against the empty object case. This type tries to allow the user to skip
// that check in some cases, where it should be safe to do so.
type GettablePossibleEmpty<Data> = keyof Data extends never
  ? EmptyObject
  : // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Partial<Data> & { [key: string]: any } extends Data
    ? Data
    : SingleKeyObject<Data> extends never
      ? Data | EmptyObject
      : {
          [K in keyof Data]+?: Data[K]
        }

/**
 * Maps a record name + path to the type used when reading.
 * Unknown records give 'unknown'.
 *
 * Unset records are represented with the 'EmptyObject' type.
 */
export type RecordNameToType<Table, Name> = Name extends keyof Table
  ? GettablePossibleEmpty<Table[Name]>
  : unknown

/**
 * Maps a record name + path to the type used when reading.
 * Unknown records give 'unknown'.
 */
export type RecordPathToType<
  Table,
  Name,
  Path extends string | readonly string[],
> = Name extends keyof Table ? Get<Table[Name], Path> | undefined : unknown

/**
 * Maps a record name + path to the type used when writing.
 * Unknown records give 'never'.
 */
export type RecordPathToWriteType<
  Table,
  Name,
  Path extends string | readonly string[],
> = Name extends keyof Table
  ? unknown extends Get<Table[Name], Path>
    ? never
    : Get<Table[Name], Path>
  : never
