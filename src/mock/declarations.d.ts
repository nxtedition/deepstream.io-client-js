declare module '@nxtedition/json-path' {
  const jsonPath: {
    get(data: unknown, path: string | string[]): unknown
    set(data: unknown, path: unknown, value: unknown): unknown
  }
  export default jsonPath
}
