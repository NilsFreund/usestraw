import { describe, expect, it } from "vitest"
import { createBroadcast } from "../../src/node/broadcast"

async function take<T>(iterator: AsyncIterator<T>, count: number): Promise<T[]> {
  const values: T[] = []
  for (let index = 0; index < count; index++) {
    const result = await iterator.next()
    if (!result.done) values.push(result.value)
  }
  return values
}

describe("createBroadcast", () => {
  it("gives every subscriber every value from the moment it subscribed", async () => {
    const broadcast = createBroadcast<number>()
    broadcast.publish(0)
    const first = broadcast[Symbol.asyncIterator]()
    broadcast.publish(1)
    const second = broadcast[Symbol.asyncIterator]()
    broadcast.publish(2)
    expect(await take(first, 2)).toStrictEqual([1, 2])
    expect(await take(second, 1)).toStrictEqual([2])
  })

  it("wakes waiting subscribers", async () => {
    const broadcast = createBroadcast<string>()
    const iterator = broadcast[Symbol.asyncIterator]()
    const waiting = iterator.next()
    broadcast.publish("a")
    expect(await waiting).toStrictEqual({ value: "a", done: false })
  })

  it("serves several pending calls in order", async () => {
    const broadcast = createBroadcast<string>()
    const iterator = broadcast[Symbol.asyncIterator]()
    const pending = [iterator.next(), iterator.next(), iterator.next()]
    broadcast.publish("a")
    broadcast.publish("b")
    broadcast.end()
    expect(await Promise.all(pending)).toStrictEqual([
      { value: "a", done: false },
      { value: "b", done: false },
      { value: undefined, done: true },
    ])
  })

  it("delivers what was buffered before the end and then finishes", async () => {
    const broadcast = createBroadcast<number>()
    const iterator = broadcast[Symbol.asyncIterator]()
    broadcast.publish(1)
    broadcast.end()
    broadcast.publish(2)
    expect(await iterator.next()).toStrictEqual({ value: 1, done: false })
    expect(await iterator.next()).toStrictEqual({ value: undefined, done: true })
    expect(await iterator.next()).toStrictEqual({ value: undefined, done: true })
  })

  it("finishes subscribers that arrive after the end", async () => {
    const broadcast = createBroadcast<number>()
    broadcast.end()
    const values: number[] = []
    for await (const value of broadcast) values.push(value)
    expect(values).toStrictEqual([])
  })

  it("unsubscribes on break and drops its buffer", async () => {
    const broadcast = createBroadcast<number>()
    const seen: number[] = []
    const iterator = broadcast[Symbol.asyncIterator]()
    broadcast.publish(1)
    broadcast.publish(2)
    for await (const value of { [Symbol.asyncIterator]: () => iterator }) {
      seen.push(value)
      break
    }
    broadcast.publish(3)
    expect(seen).toStrictEqual([1])
    expect(await iterator.next()).toStrictEqual({ value: undefined, done: true })
  })

  it("ends a pending call when the subscriber returns", async () => {
    const broadcast = createBroadcast<number>()
    const iterator = broadcast[Symbol.asyncIterator]()
    const pending = iterator.next()
    expect(await iterator.return?.()).toStrictEqual({ value: undefined, done: true })
    expect(await pending).toStrictEqual({ value: undefined, done: true })
  })
})
