export default class RpcResponse<Data> {
  completed: boolean
  reject: () => void
  error: (error: Error | string) => void
  send: (data: Data) => void
}
