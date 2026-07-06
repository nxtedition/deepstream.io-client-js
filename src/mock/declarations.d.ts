declare module '@nxtedition/json-path' {
  const jsonPath: {
    EMPTY: Record<string, unknown>
    EMPTY_OBJ: Record<string, unknown>
    EMPTY_ARR: readonly never[]
    get(data: unknown, path?: string | string[] | null): unknown
    set(
      data: unknown,
      path: string | string[] | null | undefined,
      value: unknown,
      isPlainJSON?: boolean,
    ): unknown
    merge(
      data: unknown,
      path: string | string[] | null | undefined,
      value: unknown,
      isPlainJSON?: boolean,
    ): unknown
    parse(value: string): unknown
    stringify(value: unknown): string
    jsonClone<T>(value: T): T
  }
  export default jsonPath
}
