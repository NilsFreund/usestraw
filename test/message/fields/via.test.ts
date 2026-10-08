import { describe, expect, it } from "vitest"
import {
  bareHost,
  formatHost,
  formatVia,
  parseVia,
  parseVias,
  sameHost,
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

  it.each(["SIP/3.0/UDP host", "SIP/2.0/UDP", "SIP/2.0/UDP host:70000", "SIP/2.0/UDP host;;"])(
    "rejects %s",
    (value) => {
      expect(() => parseVia(value)).toThrow(ParseError)
    },
  )
})

describe("parseVias", () => {
  it("splits comma-separated values across headers", () => {
    expect(
      parseVias(["SIP/2.0/UDP a, SIP/2.0/TCP b", "SIP/2.0/TLS c"]).map((via) => via.host),
    ).toEqual(["a", "b", "c"])
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

  it("does not mutate the original Via", () => {
    const original = parseVia("SIP/2.0/UDP 10.0.0.5;rport")
    withReceived(original, "192.0.2.20", 5060)
    expect(original.params).toEqual(new Map([["rport", null]]))
  })
})

describe("formatHost", () => {
  it.each([
    ["192.0.2.1", "192.0.2.1"],
    ["host.example.com", "host.example.com"],
    ["2001:db8::1", "[2001:db8::1]"],
    ["[2001:db8::1]", "[2001:db8::1]"],
  ])("formats %s as %s", (host, expected) => {
    expect(formatHost(host)).toBe(expected)
  })
})

describe("bareHost", () => {
  it.each([
    ["[2001:db8::1]", "2001:db8::1"],
    ["2001:db8::1", "2001:db8::1"],
    ["192.0.2.1", "192.0.2.1"],
  ])("strips brackets from %s", (host, expected) => {
    expect(bareHost(host)).toBe(expected)
  })
})

describe("sameHost", () => {
  it.each([
    ["Host.Example.com", "host.example.com"],
    ["[2001:DB8::1]", "2001:db8::1"],
    ["192.0.2.1", "192.0.2.1"],
  ])("treats %s and %s as the same host", (a, b) => {
    expect(sameHost(a, b)).toBe(true)
  })

  it("tells different hosts apart", () => {
    expect(sameHost("192.0.2.1", "192.0.2.2")).toBe(false)
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
