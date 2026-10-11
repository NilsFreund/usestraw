import type { CoreEvent } from "../core/types"

export interface Ping {
  readonly status: number
  readonly rtt: number
}

export interface Pings {
  wait(callId: string, started: number): Promise<Ping>
  settle(event: CoreEvent, now: number): void
  abort(error: Error): void
}

interface Waiting {
  readonly started: number
  resolve(ping: Ping): void
  reject(error: Error): void
}

export function createPings(): Pings {
  const waiting = new Map<string, Waiting>()

  function take(callId: string): Waiting | undefined {
    const entry = waiting.get(callId)
    waiting.delete(callId)
    return entry
  }

  return {
    wait: (callId, started) =>
      new Promise((resolve, reject) => waiting.set(callId, { started, resolve, reject })),
    settle: (event, now) => {
      if (event.type === "response" && event.response.status >= 200) {
        const entry = take(event.response.callId)
        entry?.resolve({ status: event.response.status, rtt: Math.round(now - entry.started) })
      } else if (event.type === "timeout") {
        const error = new DOMException(`No answer to OPTIONS ${event.request.uri}`, "TimeoutError")
        take(event.request.callId)?.reject(error)
      }
    },
    abort: (error) => {
      for (const entry of waiting.values()) entry.reject(error)
      waiting.clear()
    },
  }
}
