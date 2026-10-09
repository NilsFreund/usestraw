import { describe, expect, it } from "vitest"
import {
  between,
  chance,
  createRandom,
  createStreams,
  deriveSeed,
  gaussian,
} from "../../src/simulation/random"

const take = (seed: number, count: number) => Array.from({ length: count }, createRandom(seed))
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length

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

describe("deriveSeed", () => {
  it("is stable for the same seed and label", () => {
    expect(deriveSeed(1, "up:alice")).toBe(deriveSeed(1, "up:alice"))
  })

  it("differs by seed and by label", () => {
    expect(deriveSeed(1, "up:alice")).not.toBe(deriveSeed(2, "up:alice"))
    expect(deriveSeed(1, "up:alice")).not.toBe(deriveSeed(1, "down:alice"))
  })

  it("returns an unsigned 32-bit integer", () => {
    const seed = deriveSeed(123, "nat:home")
    expect(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32).toBe(true)
  })
})

describe("createStreams", () => {
  it("returns the same continuing stream for a label", () => {
    const streams = createStreams(1)
    expect(streams("a")).toBe(streams("a"))
  })

  it("gives labels independent sequences", () => {
    const streams = createStreams(1)
    expect(streams("a")()).not.toBe(streams("b")())
  })

  it("is reproducible across instances", () => {
    expect(createStreams(5)("x")()).toBe(createStreams(5)("x")())
  })
})

describe("between", () => {
  it("returns integers within the inclusive range", () => {
    const random = createRandom(3)
    const values = Array.from({ length: 1000 }, () => between(random, 10, 12))
    expect(new Set(values)).toEqual(new Set([10, 11, 12]))
  })
})

describe("chance", () => {
  it("never fires at 0 and always fires at 1", () => {
    const random = createRandom(1)
    const rolls = Array.from({ length: 1000 }, () => [chance(random, 0), chance(random, 1)])
    expect(rolls.every(([never, always]) => !never && always)).toBe(true)
  })

  it("fires at roughly the given rate", () => {
    const random = createRandom(2)
    const hits = Array.from({ length: 20_000 }, () => chance(random, 0.25)).filter(Boolean)
    expect(hits.length / 20_000).toBeCloseTo(0.25, 1)
  })
})

describe("gaussian", () => {
  it("matches mean and deviation", () => {
    const random = createRandom(4)
    const values = Array.from({ length: 20_000 }, () => gaussian(random, 100, 15))
    const average = mean(values)
    const deviation = Math.sqrt(mean(values.map((value) => (value - average) ** 2)))
    expect(Math.abs(average - 100)).toBeLessThan(0.5)
    expect(Math.abs(deviation - 15)).toBeLessThan(0.5)
  })

  it("returns the mean without deviation", () => {
    expect(gaussian(createRandom(1), 42, 0)).toBe(42)
  })
})
