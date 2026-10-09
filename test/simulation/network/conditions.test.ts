import { describe, expect, it } from "vitest"
import { accessLink, latency, loss } from "../../../src/simulation/network/conditions"

describe("latency", () => {
  it("builds the three distributions", () => {
    expect(latency.fixed(20)).toEqual({ kind: "fixed", ms: 20 })
    expect(latency.uniform(10, 30)).toEqual({ kind: "uniform", min: 10, max: 30 })
    expect(latency.normal(40, 5)).toEqual({ kind: "normal", mean: 40, deviation: 5 })
  })
})

describe("loss", () => {
  it("builds random and burst loss", () => {
    expect(loss.random(0.1)).toEqual({ kind: "random", rate: 0.1 })
    expect(loss.burst(0.05, 4)).toEqual({ kind: "burst", rate: 0.05, length: 4 })
  })
})

describe("accessLink", () => {
  it("uses symmetric conditions for both directions", () => {
    const conditions = { latency: latency.fixed(5) }
    expect(accessLink(conditions)).toEqual({ up: conditions, down: conditions })
  })

  it("keeps asymmetric links", () => {
    const link = { up: { down: true }, down: {} }
    expect(accessLink(link)).toBe(link)
  })
})
