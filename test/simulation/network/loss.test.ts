import { describe, expect, it } from "vitest"
import { loss } from "../../../src/simulation/network/conditions"
import { createLossModel } from "../../../src/simulation/network/loss"
import { createRandom } from "../../../src/simulation/random"

function run(spec: Parameters<typeof createLossModel>[0], count: number): boolean[] {
  const lost = createLossModel(spec, createRandom(11))
  return Array.from({ length: count }, () => lost())
}

function bursts(outcomes: boolean[]): number[] {
  const lengths: number[] = []
  let current = 0
  for (const lost of [...outcomes, false]) {
    if (lost) current++
    else if (current > 0) {
      lengths.push(current)
      current = 0
    }
  }
  return lengths
}

const rate = (outcomes: boolean[]) => outcomes.filter(Boolean).length / outcomes.length

describe("createLossModel", () => {
  it("never loses without a loss model", () => {
    expect(run(undefined, 1000).some(Boolean)).toBe(false)
  })

  it("loses independently at the given rate", () => {
    expect(Math.abs(rate(run(loss.random(0.1), 50_000)) - 0.1)).toBeLessThan(0.01)
  })

  it("loses in bursts with the given average rate and burst length", () => {
    const outcomes = run(loss.burst(0.1, 4), 200_000)
    const lengths = bursts(outcomes)
    const averageLength = lengths.reduce((sum, length) => sum + length, 0) / lengths.length
    expect(Math.abs(rate(outcomes) - 0.1)).toBeLessThan(0.01)
    expect(Math.abs(averageLength - 4)).toBeLessThan(0.3)
  })

  it("keeps random loss scattered", () => {
    const lengths = bursts(run(loss.random(0.1), 200_000))
    const averageLength = lengths.reduce((sum, length) => sum + length, 0) / lengths.length
    expect(averageLength).toBeLessThan(1.2)
  })

  it("reaches the highest burst rate the model allows", () => {
    expect(Math.abs(rate(run(loss.burst(0.8, 4), 200_000)) - 0.8)).toBeLessThan(0.01)
  })

  it("never loses with a zero burst rate", () => {
    expect(run(loss.burst(0, 3), 1000).some(Boolean)).toBe(false)
  })
})
