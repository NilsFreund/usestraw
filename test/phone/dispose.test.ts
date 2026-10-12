import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("asyncDispose", () => {
  it("is the runtime's symbol where there is one", async () => {
    const { asyncDispose } = await import("../../src/phone/dispose")
    expect(asyncDispose).toBe(Symbol.asyncDispose)
  })

  it("falls back to the symbol compiled `await using` looks up, where the runtime has none", async () => {
    const real = Symbol
    const without = new Proxy(() => undefined, {
      get: (_, key) => (key === "asyncDispose" ? undefined : Reflect.get(real, key)),
      apply: (_, __, args: [string?]) => real(...args),
    })
    vi.stubGlobal("Symbol", without)
    vi.resetModules()
    const { asyncDispose } = await import("../../src/phone/dispose")
    expect(asyncDispose).toBe(real.for("Symbol.asyncDispose"))
  })
})
