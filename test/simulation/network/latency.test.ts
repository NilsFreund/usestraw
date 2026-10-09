import { describe, expect, it } from "vitest"
import { latency } from "../../../src/simulation/network/conditions"
import { sampleLatency } from "../../../src/simulation/network/latency"
import { createRandom } from "../../../src/simulation/random"

const samples = (spec: Parameters<typeof sampleLatency>[0], count = 10_000) => {
  const random = createRandom(9)
  return Array.from({ length: count }, () => sampleLatency(spec, random))
}

describe("sampleLatency", () => {
  it("returns fixed latency unchanged", () => {
    expect(new Set(samples(latency.fixed(25), 100))).toEqual(new Set([25]))
  })

  it("spreads uniform latency over the whole inclusive range", () => {
    expect(new Set(samples(latency.uniform(10, 14)))).toEqual(new Set([10, 11, 12, 13, 14]))
  })

  it("centers normal latency on the mean with whole milliseconds", () => {
    const values = samples(latency.normal(80, 10))
    const average = values.reduce((sum, value) => sum + value, 0) / values.length
    expect(Math.abs(average - 80)).toBeLessThan(0.5)
    expect(values.every(Number.isInteger)).toBe(true)
  })

  it("never returns negative latency", () => {
    const values = samples(latency.normal(2, 10))
    expect(Math.min(...values)).toBe(0)
  })
})
