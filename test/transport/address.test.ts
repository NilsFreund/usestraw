import { describe, expect, it } from "vitest"
import {
  defaultPort,
  isAddress,
  isReliable,
  type TransportAddress,
} from "../../src/transport/address"
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

describe("isAddress", () => {
  const valid: TransportAddress[] = [
    alice,
    { transport: "TLS", host: "sip.example.com", port: 5061 },
    { transport: "WSS", host: "2001:db8::1", port: 443 },
    { transport: "TCP", host: "[2001:db8::1]", port: 0 },
    { transport: "WS", host: "localhost", port: 65535 },
  ]

  it.each(valid)("accepts %o", (address) => {
    expect(isAddress(address)).toBe(true)
  })

  const invalid: TransportAddress[] = [
    { ...alice, transport: "SCTP" as TransportAddress["transport"] },
    { ...alice, transport: "udp" as TransportAddress["transport"] },
    { ...alice, host: "" },
    { ...alice, host: "evil host" },
    { ...alice, host: "192.0.2.10\r\nX: y" },
    { ...alice, port: -1 },
    { ...alice, port: 65536 },
    { ...alice, port: 5060.5 },
  ]

  it.each(invalid)("rejects %o", (address) => {
    expect(isAddress(address)).toBe(false)
  })
})
