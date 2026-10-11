import { describe, expect, it } from "vitest"
import { backoff } from "../../src/support/backoff"

describe("backoff", () => {
  it("doubles from the base up to the cap, between half and all of it", () => {
    expect([0, 1, 2, 3, 10].map((attempt) => backoff(attempt, 1000, 6000, () => 0))).toStrictEqual([
      500, 1000, 2000, 3000, 3000,
    ])
    expect(backoff(2, 1000, 6000, () => 0.999)).toBe(3998)
  })
})
