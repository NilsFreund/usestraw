import { afterEach, describe, expect, it, vi } from "vitest"
import { createListeners } from "../../src/phone/listeners"

afterEach(() => vi.restoreAllMocks())

describe("createListeners", () => {
  it("calls every subscriber, also the same function twice, until it unsubscribes", () => {
    const listeners = createListeners()
    const calls: string[] = []
    const listener = () => calls.push("a")
    const first = listeners.subscribe(listener)
    listeners.subscribe(listener)
    listeners.subscribe(() => calls.push("b"))
    listeners.notify()
    first()
    first()
    listeners.notify()
    expect(calls).toStrictEqual(["a", "a", "b", "a", "b"])
  })

  it("lets a listener unsubscribe itself while being notified", () => {
    const listeners = createListeners()
    const calls: string[] = []
    const off = listeners.subscribe(() => {
      calls.push("once")
      off()
    })
    listeners.subscribe(() => calls.push("always"))
    listeners.notify()
    listeners.notify()
    expect(calls).toStrictEqual(["once", "always", "always"])
  })

  it("skips listeners removed during a notification and waits with new ones until the next", () => {
    const listeners = createListeners()
    const calls: string[] = []
    let offLater = () => {}
    listeners.subscribe(() => {
      calls.push("first")
      offLater()
      listeners.subscribe(() => calls.push("added"))
    })
    offLater = listeners.subscribe(() => calls.push("removed"))
    listeners.notify()
    expect(calls).toStrictEqual(["first"])
    listeners.notify()
    expect(calls).toStrictEqual(["first", "first", "added"])
  })

  it("reports a throwing listener asynchronously and still notifies the others", () => {
    const reported: (() => void)[] = []
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => reported.push(task))
    const listeners = createListeners()
    const calls: string[] = []
    listeners.subscribe(() => {
      throw new Error("broken listener")
    })
    listeners.subscribe(() => calls.push("next"))
    listeners.notify()
    expect(calls).toStrictEqual(["next"])
    expect(reported).toHaveLength(1)
    expect(() => reported[0]?.()).toThrow("broken listener")
  })
})
