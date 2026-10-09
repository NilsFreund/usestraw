import { describe, expect, it } from "vitest"
import { loss } from "../../../src/simulation/network/conditions"
import { createLossModel } from "../../../src/simulation/network/loss"
import { createRandom } from "../../../src/simulation/random"
import { tolerance } from "../support"

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
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length

function independentSamples(lossRate: number, length: number, samples: number): number {
  const recover = 1 / length
  const memory = 1 - recover - (lossRate * recover) / (1 - lossRate)
  return (samples * (1 - memory)) / (1 + memory)
}

function lengthTolerance(mean: number, bursts: number): number {
  return (4 * Math.sqrt(mean * (mean - 1))) / Math.sqrt(bursts)
}

describe("createLossModel", () => {
  it("never loses without a loss model", () => {
    expect(run(undefined, 1000).some(Boolean)).toBe(false)
  })

  it("loses independently at the given rate", () => {
    expect(Math.abs(rate(run(loss.random(0.1), 200_000)) - 0.1)).toBeLessThan(
      tolerance(0.1, 200_000),
    )
  })

  it("loses in bursts with the given average rate and burst length", () => {
    const outcomes = run(loss.burst(0.1, 4), 200_000)
    const lengths = bursts(outcomes)
    expect(Math.abs(rate(outcomes) - 0.1)).toBeLessThan(
      tolerance(0.1, independentSamples(0.1, 4, 200_000)),
    )
    expect(Math.abs(average(lengths) - 4)).toBeLessThan(lengthTolerance(4, lengths.length))
  })

  it("keeps random loss scattered", () => {
    const lengths = bursts(run(loss.random(0.1), 200_000))
    expect(Math.abs(average(lengths) - 1 / 0.9)).toBeLessThan(
      lengthTolerance(1 / 0.9, lengths.length),
    )
  })

  it("reaches the highest burst rate the model allows", () => {
    expect(Math.abs(rate(run(loss.burst(0.8, 4), 200_000)) - 0.8)).toBeLessThan(
      tolerance(0.8, independentSamples(0.8, 4, 200_000)),
    )
  })

  it("never loses with a zero burst rate", () => {
    expect(run(loss.burst(0, 3), 1000).some(Boolean)).toBe(false)
  })
})
