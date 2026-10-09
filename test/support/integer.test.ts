import { describe, expect, it } from "vitest"
import { isIntegerIn } from "../../src/support/integer"

describe("isIntegerIn", () => {
  it.each([0, 1, 255])("accepts %d within 0..255", (value) => {
    expect(isIntegerIn(value, 0, 255)).toBe(true)
  })

  it.each([-1, 256, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %d", (value) => {
    expect(isIntegerIn(value, 0, 255)).toBe(false)
  })
})
