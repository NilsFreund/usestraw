import type { CallHandle } from "./call"
import type { RingingCall } from "./types"

export interface Inbox extends AsyncIterable<RingingCall> {
  push(handle: CallHandle): void
  close(): void
}

/** The calls that still ring, for `for await`; it ends when the phone closes. */
export function createInbox(): Inbox {
  let waiting: CallHandle[] = []
  const readers: ((result: IteratorResult<RingingCall>) => void)[] = []
  let closed = false

  function next(): Promise<IteratorResult<RingingCall>> {
    for (let handle = waiting.shift(); handle; handle = waiting.shift()) {
      if (handle.call.status === "ringing") {
        return Promise.resolve({ value: handle.call, done: false })
      }
    }
    if (closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => readers.push(resolve))
  }

  return {
    push: (handle) => {
      waiting = waiting.filter((waited) => waited.call.status === "ringing")
      const reader = readers.shift()
      if (reader) reader({ value: handle.call as RingingCall, done: false })
      else waiting.push(handle)
    },
    close: () => {
      closed = true
      waiting = []
      for (const reader of readers.splice(0)) reader({ value: undefined, done: true })
    },
    [Symbol.asyncIterator]: () => ({
      next,
      return: async () => ({ value: undefined, done: true }),
    }),
  }
}
