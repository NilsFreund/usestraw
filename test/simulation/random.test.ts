import { describe, expect, it } from "vitest"
import { between, createRandom } from "../../src/simulation/random"

const take = (seed: number, count: number) => Array.from({ length: count }, createRandom(seed))

describe("createRandom", () => {
  it("repeats the same sequence for the same seed", () => {
    expect(take(42, 5)).toEqual(take(42, 5))
  })

  it("produces different sequences for different seeds", () => {
    expect(take(1, 5)).not.toEqual(take(2, 5))
  })

  it("stays within [0, 1)", () => {
    expect(take(7, 10_000).every((value) => value >= 0 && value < 1)).toBe(true)
  })
})

describe("between", () => {
  it("returns integers within the inclusive range", () => {
    const random = createRandom(3)
    const values = Array.from({ length: 1000 }, () => between(random, 10, 12))
    expect(new Set(values)).toEqual(new Set([10, 11, 12]))
  })
})
