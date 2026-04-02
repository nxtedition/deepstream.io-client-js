import { Observable } from 'rxjs'

export default class EventHandler {
  connected: boolean
  stats: EventStats
  subscribe: (name: string, callback: (data: unknown) => void) => void
  unsubscribe: (name: string, callback: (data: unknown) => void) => void
  on: (name: string, callback: (data: unknown) => void) => this
  once: (name: string, callback: (data: unknown) => void) => this
  off: (name: string, callback: (data: unknown) => void) => this
  observe: <Data>(name: string) => Observable<Data>
  emit: <Data>(name: string, data?: Data) => void
  provide: (pattern: string, callback: (name: string) => void, options: unknown) => () => void
}

export interface EventStats {
  emitted: number
  listeners: number
  events: number
}
