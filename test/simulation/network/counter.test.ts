import { describe, expect, it } from "vitest"
import { createCounter } from "../../../src/simulation/network/counter"

describe("createCounter", () => {
  it("holds a key until every add is removed", () => {
    const counter = createCounter()
    counter.add("a")
    counter.add("a")
    counter.remove("a")
    expect(counter.has("a")).toBe(true)
    counter.remove("a")
    expect(counter.has("a")).toBe(false)
  })

  it("ignores removing keys that were never added", () => {
    const counter = createCounter()
    counter.remove("a")
    counter.add("a")
    expect(counter.has("a")).toBe(true)
    expect(counter.has("b")).toBe(false)
  })
})
