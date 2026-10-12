import { afterEach, describe, expect, it, vi } from "vitest"
import { createClock } from "../../src/phone/clock"

afterEach(() => vi.useRealTimers())

describe("createClock", () => {
  it("counts milliseconds from its creation", () => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(5000)
    const clock = createClock()
    expect(clock.now()).toBe(0)
    vi.advanceTimersByTime(250)
    expect(clock.now()).toBe(250)
  })

  it("fires once at the deadline and drops the schedule it replaces", () => {
    vi.useFakeTimers()
    const clock = createClock()
    const fired: string[] = []
    clock.schedule(clock.now() + 5, () => fired.push("replaced"))
    clock.schedule(clock.now() + 20, () => fired.push("current"))
    vi.advanceTimersByTime(19)
    expect(fired).toStrictEqual([])
    vi.advanceTimersByTime(41)
    expect(fired).toStrictEqual(["current"])
  })

  it("fires at once for a deadline in the past and never after cancel or without deadline", () => {
    vi.useFakeTimers()
    const clock = createClock()
    const fired: string[] = []
    clock.schedule(-1000, () => fired.push("past"))
    vi.advanceTimersByTime(0)
    clock.schedule(clock.now() + 5, () => fired.push("cancelled"))
    clock.cancel()
    clock.schedule(undefined, () => fired.push("none"))
    vi.advanceTimersByTime(20)
    expect(fired).toStrictEqual(["past"])
  })

  it("clamps far deadlines to the largest timer Node accepts", () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, "setTimeout")
    createClock().schedule(Number.MAX_SAFE_INTEGER, () => {})
    expect(spy).toHaveBeenLastCalledWith(expect.any(Function), 2 ** 31 - 1)
  })
})
