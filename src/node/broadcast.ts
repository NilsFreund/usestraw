export interface Broadcast<T> extends AsyncIterable<T> {
  publish(value: T): void
  end(): void
}

interface Subscriber<T> {
  readonly buffer: T[]
  readonly waiting: ((result: IteratorResult<T, undefined>) => void)[]
}

const DONE = { value: undefined, done: true } as const

export function createBroadcast<T>(): Broadcast<T> {
  const subscribers = new Set<Subscriber<T>>()
  let ended = false

  function finish(subscriber: Subscriber<T>): void {
    subscribers.delete(subscriber)
    for (const resolve of subscriber.waiting.splice(0)) resolve(DONE)
  }

  function subscribe(): AsyncIterator<T, undefined> {
    const subscriber: Subscriber<T> = { buffer: [], waiting: [] }
    if (!ended) subscribers.add(subscriber)
    return {
      next: () => {
        if (subscriber.buffer.length > 0) {
          return Promise.resolve({ value: subscriber.buffer.shift() as T, done: false })
        }
        if (!subscribers.has(subscriber)) return Promise.resolve(DONE)
        return new Promise((resolve) => subscriber.waiting.push(resolve))
      },
      return: () => {
        subscriber.buffer.length = 0
        finish(subscriber)
        return Promise.resolve(DONE)
      },
    }
  }

  return {
    publish: (value) => {
      for (const subscriber of subscribers) {
        const resolve = subscriber.waiting.shift()
        if (resolve) resolve({ value, done: false })
        else subscriber.buffer.push(value)
      }
    },
    end: () => {
      ended = true
      for (const subscriber of subscribers) finish(subscriber)
    },
    [Symbol.asyncIterator]: subscribe,
  }
}
