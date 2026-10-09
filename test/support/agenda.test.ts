import { describe, expect, it } from "vitest"
import { createAgenda } from "../../src/support/agenda"

describe("createAgenda", () => {
  it("starts empty", () => {
    const agenda = createAgenda<string>()
    expect(agenda.size).toBe(0)
    expect(agenda.next()).toBeUndefined()
    expect(agenda.take(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it("orders by time and keeps insertion order for equal times", () => {
    const agenda = createAgenda<string>()
    agenda.push(20, "c")
    agenda.push(10, "a")
    agenda.push(10, "b")
    agenda.push(5, "first")
    expect(agenda.size).toBe(4)
    expect(agenda.next()).toBe(5)
    const taken = [agenda.take(99), agenda.take(99), agenda.take(99), agenda.take(99)]
    expect(taken).toEqual(["first", "a", "b", "c"])
    expect(agenda.size).toBe(0)
  })

  it("peeks at the next item without taking it", () => {
    const agenda = createAgenda<string>()
    expect(agenda.peek()).toBeUndefined()
    agenda.push(20, "b")
    agenda.push(10, "a")
    expect(agenda.peek()).toBe("a")
    expect(agenda.size).toBe(2)
  })

  it("only hands out items that are due", () => {
    const agenda = createAgenda<string>()
    agenda.push(10, "later")
    expect(agenda.take(9)).toBeUndefined()
    expect(agenda.take(10)).toBe("later")
  })
})

describe("createAgenda at scale", () => {
  it("hands out thousands of shuffled items in time and insertion order", () => {
    const agenda = createAgenda<number>()
    const times = Array.from({ length: 5000 }, (_, index) => (index * 7919) % 1000)
    for (const [index, time] of times.entries()) agenda.push(time, index)
    const taken: number[] = []
    for (let item = agenda.take(Infinity); item !== undefined; item = agenda.take(Infinity)) {
      taken.push(item)
    }
    const expected = times
      .map((time, index) => ({ time, index }))
      .sort((a, b) => a.time - b.time || a.index - b.index)
      .map((entry) => entry.index)
    expect(taken).toEqual(expected)
  })

  it("interleaves pushes and takes like a simulation does", () => {
    const agenda = createAgenda<string>()
    agenda.push(10, "a")
    agenda.push(30, "c")
    expect(agenda.take(10)).toBe("a")
    agenda.push(20, "b")
    agenda.push(20, "b2")
    expect([agenda.take(99), agenda.take(99), agenda.take(99)]).toEqual(["b", "b2", "c"])
  })
})
