import { Observable } from 'rxjs'

export default class EventHandler {
  connected: boolean
  stats: EventStats
  subscribe: (name: string, callback: () => void) => void
  unsubscribe: (name: string, callback: () => void) => void
  on: (name: string, callback: () => void) => this
  once: (name: string, callback: () => void) => this
  off: (name: string, callback: () => void) => this
  observe: <Data>(name: string) => Observable<Data>
  emit: <Data>(name: string, data: Data) => void
  provide: (pattern: string, callback: (name: string) => void, options: unknown) => () => void
}

export interface EventStats {
  emitted: number
  listeners: number
  events: number
}
