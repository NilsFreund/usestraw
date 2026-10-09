import { describe, expect, it } from "vitest"
import { checkTime, earliest } from "../../src/support/time"

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

describe("checkTime", () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])("accepts %d", (now) => {
    expect(() => checkTime(now)).not.toThrow()
  })

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 2,
    -Number.MAX_SAFE_INTEGER - 2,
  ])("rejects %d", (now) => {
    expect(() => checkTime(now)).toThrow(new RangeError(`Invalid time ${now}`))
  })
})
