import { describe, expect, it } from "vitest"
import { randomInt } from "../../src/support/random"

describe("randomInt", () => {
  it.each([
    [0, 0],
    [0.5, 5],
    [0.999_999_999, 9],
    [1, 9],
  ])("maps random() = %s to %s in [0, 10)", (value, expected) => {
    expect(randomInt(() => value, 10)).toBe(expected)
  })
})
