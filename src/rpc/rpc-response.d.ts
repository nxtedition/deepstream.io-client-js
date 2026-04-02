export default class RpcResponse<Data> {
  reject: () => void
  error: (error: Error | string) => void
  send: (data: Data) => void
}
