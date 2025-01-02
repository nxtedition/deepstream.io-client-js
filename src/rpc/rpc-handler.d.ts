import RpcResponse from './rpc-response.js'

export type RpcMethodDef = [arguments: unknown, response: unknown]

export default class RpcHandler<Methods extends Record<string, RpcMethodDef>> {
  connected: boolean
  stats: RpcStats

  provide: <Name extends keyof Methods>(
    name: Name,
    callback: (args: Methods[Name][0], response: RpcResponse<Methods[Name][1]>) => void,
  ) => UnprovideFn

  unprovide: <Name extends keyof Methods>(name: Name) => void

  make: {
    <Name extends keyof Methods>(
      name: Name,
      args: Methods[Name][0],
      callback: (error: unknown, response: Methods[Name][1]) => void,
    ): void
    <Name extends keyof Methods>(name: Name, args: Methods[Name][0]): Promise<Methods[Name][1]>
  }
}

type UnprovideFn = () => void

export interface RpcStats {
  listeners: number
  rpcs: number
}
