import { describe, expect, it } from "vitest"
import { formatVia, parseVia, parseVias } from "../../../src/message/fields/via"
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
