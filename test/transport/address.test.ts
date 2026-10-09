import { describe, expect, it } from "vitest"
import { defaultPort, isReliable } from "../../src/transport/address"
import { alice } from "../helpers"

describe("isReliable", () => {
  it.each([
    ["UDP", false],
    ["TCP", true],
    ["TLS", true],
    ["WS", true],
    ["WSS", true],
  ] as const)("treats %s as reliable: %s", (transport, reliable) => {
    expect(isReliable({ ...alice, transport })).toBe(reliable)
  })
})

describe("defaultPort", () => {
  it("uses 5061 for TLS and 5060 otherwise", () => {
    expect(["UDP", "TCP", "tls", "TLS", "WS"].map(defaultPort)).toEqual([
      5060, 5060, 5061, 5061, 5060,
    ])
  })
})
