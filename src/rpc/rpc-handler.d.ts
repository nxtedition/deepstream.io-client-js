import RpcResponse from './rpc-response.js'

export type RpcMethodDef = [arguments: unknown, response: unknown]

export default class RpcHandler<
  Methods extends Record<string, RpcMethodDef> = Record<string, RpcMethodDef>,
> {
  connected: boolean
  stats: RpcStats

  provide: <Name extends keyof Methods>(
    name: Name,
    callback: (args: Methods[Name][0], response: RpcResponse<Methods[Name][1]>) => void,
  ) => UnprovideFn

  unprovide: <Name extends keyof Methods>(name: Name) => void

  make: {
    <
      Name extends keyof Methods | string,
      Args extends Name extends keyof Methods ? Methods[Name][0] : unknown,
      ReturnValue extends Name extends keyof Methods ? Methods[Name][1] : unknown,
    >(
      name: Name,
      args: Args,
    ): Promise<ReturnValue>
    <
      Name extends keyof Methods | string,
      Args extends Name extends keyof Methods ? Methods[Name][0] : unknown,
      ReturnValue extends Name extends keyof Methods ? Methods[Name][1] : unknown,
    >(
      name: Name,
      args: Args,
      callback: (error: unknown, response: ReturnValue) => void,
    ): void
  }
}

type UnprovideFn = () => void

export interface RpcStats {
  listeners: number
  rpcs: number
}
