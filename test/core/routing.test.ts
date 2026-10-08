import { describe, expect, it } from "vitest"
import type { Address } from "../../src"
import { replyAddress } from "../../src/core/routing"
import { parseVia } from "../../src/message/fields/via"

const source: Address = { transport: "UDP", host: "203.0.113.7", port: 40123 }

describe("replyAddress (RFC 3261 §18.2.2, RFC 3581)", () => {
  it("replies to the source address and port when rport is present", () => {
    expect(replyAddress(parseVia("SIP/2.0/UDP 10.0.0.5:5070;rport=40123"), source)).toEqual(source)
  })

  it("replies to the received address and the sent-by port without rport", () => {
    expect(replyAddress(parseVia("SIP/2.0/UDP 10.0.0.5:5070"), source)).toEqual({
      ...source,
      port: 5070,
    })
  })

  it("defaults to port 5060 when sent-by has no port", () => {
    expect(replyAddress(parseVia("SIP/2.0/UDP host.example.com"), source)).toEqual({
      ...source,
      port: 5060,
    })
  })

  it("replies over the same flow on reliable transports", () => {
    const tcp: Address = { ...source, transport: "TCP" }
    expect(replyAddress(parseVia("SIP/2.0/TCP 10.0.0.5:5070"), tcp)).toEqual(tcp)
  })

  it("falls back to the default port without a Via", () => {
    expect(replyAddress(undefined, source)).toEqual({ ...source, port: 5060 })
  })
})
