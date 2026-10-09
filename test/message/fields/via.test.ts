import { describe, expect, it } from "vitest"
import {
  formatVia,
  isVia,
  parseVia,
  parseVias,
  withReceived,
} from "../../../src/message/fields/via"
import { ParseError } from "../../../src/message/syntax"

describe("parseVia", () => {
  it("parses transport, host, port and params", () => {
    expect(
      parseVia("SIP / 2.0 / tcp proxy.example.com : 5061 ; branch = z9hG4bK1 ; rport"),
    ).toEqual({
      transport: "TCP",
      host: "proxy.example.com",
      port: 5061,
      params: new Map([
        ["branch", "z9hG4bK1"],
        ["rport", null],
      ]),
    })
  })

  it("parses IPv6 references", () => {
    expect(parseVia("SIP/2.0/UDP [2001:db8::1]:5060")).toMatchObject({
      host: "[2001:db8::1]",
      port: 5060,
    })
  })

  it("accepts the highest port", () => {
    expect(parseVia("SIP/2.0/UDP host:65535").port).toBe(65535)
  })

  it.each([
    "SIP/3.0/UDP host",
    "SIP/2.0/UDP",
    "SIP/2.0/UDP host:70000",
    "SIP/2.0/UDP host:65536",
    "SIP/2.0/UDP host;;",
  ])("rejects %s", (value) => {
    expect(() => parseVia(value)).toThrow(ParseError)
  })
})

describe("parseVias", () => {
  it("splits comma-separated values across headers", () => {
    expect(
      parseVias(["SIP/2.0/UDP a, SIP/2.0/TCP b", "SIP/2.0/TLS c"]).map((via) => via.host),
    ).toEqual(["a", "b", "c"])
  })
})

describe("parseVias limits", () => {
  it("accepts up to 70 entries and rejects more", () => {
    const vias = (count: number) => [Array.from({ length: count }, () => "SIP/2.0/UDP a").join(",")]
    expect(parseVias(vias(70))).toHaveLength(70)
    expect(() => parseVias(vias(71))).toThrow("Too many Via entries (limit 70)")
  })
})

describe("isVia", () => {
  const valid = parseVia("SIP/2.0/UDP host:5060;branch=z9hG4bK1;rport")

  it.each([
    valid,
    { ...valid, port: 0 },
    { ...valid, port: 65535 },
    { transport: "TLS", host: "[2001:db8::1]", params: new Map() },
  ])("accepts %o", (via) => {
    expect(isVia(via)).toBe(true)
  })

  it.each([
    { ...valid, transport: "U DP" },
    { ...valid, host: "evil host" },
    { ...valid, host: "2001:db8::1" },
    { ...valid, port: 65536 },
    { ...valid, port: -1 },
    { ...valid, params: new Map([["branch", "a\r\nX: y"]]) },
  ])("rejects %o", (via) => {
    expect(isVia(via)).toBe(false)
  })
})

describe("formatVia", () => {
  it("writes the canonical form", () => {
    expect(formatVia(parseVia("SIP / 2.0 / udp host : 5060 ; rport ; branch=z9hG4bK1"))).toBe(
      "SIP/2.0/UDP host:5060;rport;branch=z9hG4bK1",
    )
  })
})

describe("withReceived", () => {
  it("adds received when the source differs from sent-by (RFC 3261 §18.2.1)", () => {
    const via = withReceived(
      parseVia("SIP/2.0/UDP 10.0.0.5:5060;branch=z9hG4bK1"),
      "192.0.2.20",
      5060,
    )
    expect(via.params).toEqual(
      new Map([
        ["branch", "z9hG4bK1"],
        ["received", "192.0.2.20"],
      ]),
    )
  })

  it("leaves Via alone when the source matches and rport is absent", () => {
    const original = parseVia("SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bK1")
    expect(withReceived(original, "192.0.2.20", 5060)).toEqual(original)
  })

  it("fills rport and always adds received when rport is requested (RFC 3581)", () => {
    const via = withReceived(parseVia("SIP/2.0/UDP 192.0.2.20:5060;rport"), "192.0.2.20", 40123)
    expect(via.params).toEqual(
      new Map([
        ["rport", "40123"],
        ["received", "192.0.2.20"],
      ]),
    )
  })

  it("leaves the zone of a link-local source out of received", () => {
    const via = withReceived(parseVia("SIP/2.0/UDP [fe80::2];rport"), "fe80::1%en0", 5060)
    expect(via.params.get("received")).toBe("fe80::1")
  })

  it("does not mutate the original Via", () => {
    const original = parseVia("SIP/2.0/UDP 10.0.0.5;rport")
    withReceived(original, "192.0.2.20", 5060)
    expect(original.params).toEqual(new Map([["rport", null]]))
  })
})

describe("withReceived host comparison", () => {
  it("does not add received for a sent-by that differs only in case", () => {
    const via = withReceived(
      parseVia("SIP/2.0/UDP [2001:DB8::1]:5060;branch=z9hG4bK1"),
      "2001:db8::1",
      5060,
    )
    expect(via.params.has("received")).toBe(false)
  })
})
