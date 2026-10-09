import { describe, expect, it } from "vitest"
import { profiles } from "../../../src/simulation/network/profiles"
import { validateConditions } from "../../../src/simulation/network/validate"

describe("profiles", () => {
  it("offers the known network types", () => {
    expect(Object.keys(profiles)).toEqual([
      "perfect",
      "lan",
      "fiber",
      "cable",
      "dsl",
      "office",
      "wifi",
      "badWifi",
      "lte",
      "mobile3g",
      "satellite",
      "congested",
      "bufferbloat",
      "fragmentHostile",
    ])
  })

  it.each(Object.entries(profiles))("has valid conditions for %s", (_, conditions) => {
    expect(() => validateConditions(conditions)).not.toThrow()
  })

  it("keeps the perfect profile free of impairments", () => {
    expect(profiles.perfect).toEqual({})
  })

  it("models fragment-hostile paths with small MTUs", () => {
    expect(profiles.lte.mtu).toBe(1400)
    expect(profiles.fragmentHostile.mtu).toBe(1300)
  })

  it("models congestion with a small buffer and bufferbloat with a large one", () => {
    expect(profiles.congested.buffer).toBeLessThan(profiles.bufferbloat.buffer ?? 0)
  })
})
