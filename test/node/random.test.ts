import { describe, expect, it } from "vitest"
import { secureRandom } from "../../src/node/random"

describe("secureRandom", () => {
  it("draws distinct numbers from [0, 1)", () => {
    const values = Array.from({ length: 1000 }, secureRandom)
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true)
    expect(new Set(values).size).toBeGreaterThan(990)
  })
})
