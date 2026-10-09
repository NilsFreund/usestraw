import { describe, expect, it } from "vitest"
import { earliest } from "../../src/support/time"

describe("earliest", () => {
  it("returns the smallest time", () => {
    expect(earliest([30, 10, 20])).toBe(10)
  })

  it("skips undefined times", () => {
    expect(earliest([undefined, 5, undefined])).toBe(5)
  })

  it("returns undefined when there is nothing scheduled", () => {
    expect(earliest([])).toBeUndefined()
    expect(earliest([undefined])).toBeUndefined()
  })

  it("accepts any iterable", () => {
    expect(earliest(new Set([3, 1]).values())).toBe(1)
  })
})
