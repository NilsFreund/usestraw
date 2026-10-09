import { describe, expect, it } from "vitest"
import { type LinkConditions, latency, loss } from "../../../src/simulation/network/conditions"
import { validateConditions } from "../../../src/simulation/network/validate"

describe("validateConditions", () => {
  it("accepts complete and edge-case conditions", () => {
    const complete: LinkConditions = {
      latency: latency.normal(0, 0),
      spikes: { chance: 1, latency: latency.uniform(0, 0) },
      loss: loss.burst(0, 1),
      duplicate: 0,
      corrupt: 1,
      bandwidth: 1,
      buffer: 0,
      mtu: 1,
      ordered: true,
      down: false,
    }
    expect(() => validateConditions(complete)).not.toThrow()
    expect(() =>
      validateConditions({ latency: latency.fixed(0), loss: loss.random(1) }),
    ).not.toThrow()
    expect(() => validateConditions({})).not.toThrow()
  })

  it.each<[string, LinkConditions]>([
    ["latency must be at least 0, got -1", { latency: latency.fixed(-1) }],
    ["latency.min must be at least 0, got -1", { latency: latency.uniform(-1, 5) }],
    ["latency.max must be at least 10, got 5", { latency: latency.uniform(10, 5) }],
    ["latency.mean must be at least 0, got -1", { latency: latency.normal(-1, 1) }],
    ["latency.deviation must be at least 0, got -1", { latency: latency.normal(1, -1) }],
    [
      "spikes.chance must be within [0, 1], got 2",
      { spikes: { chance: 2, latency: latency.fixed(1) } },
    ],
    ["latency must be at least 0, got -5", { spikes: { chance: 0.1, latency: latency.fixed(-5) } }],
    ["loss.rate must be within [0, 1], got 1.5", { loss: loss.random(1.5) }],
    ["loss.rate must be at least 0, got -0.1", { loss: loss.burst(-0.1, 2) }],
    ["loss.rate must be at most 0.667 for bursts of length 2, got 1", { loss: loss.burst(1, 2) }],
    [
      "loss.rate must be at most 0.667 for bursts of length 2, got 0.9",
      { loss: loss.burst(0.9, 2) },
    ],
    [
      "loss.rate must be at most 0.500 for bursts of length 1, got 0.6",
      { loss: loss.burst(0.6, 1) },
    ],
    ["loss.length must be at least 1, got 0.5", { loss: loss.burst(0.1, 0.5) }],
    ["duplicate must be within [0, 1], got -0.1", { duplicate: -0.1 }],
    ["duplicate must be within [0, 1], got NaN", { duplicate: Number.NaN }],
    ["corrupt must be within [0, 1], got 2", { corrupt: 2 }],
    ["bandwidth must be positive, got 0", { bandwidth: 0 }],
    ["buffer must be at least 0, got -1", { buffer: -1 }],
    ["mtu must be positive, got 0", { mtu: 0 }],
    ["buffer requires a bandwidth", { buffer: 4000 }],
  ])("rejects with %s", (message, conditions) => {
    expect(() => validateConditions(conditions)).toThrow(new RangeError(message))
  })
})
