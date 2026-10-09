import { describe, expect, it } from "vitest"
import type { Address } from "../../src"
import { createResponse, isRequest } from "../../src"
import { parseVia } from "../../src/message/fields/via"
import { parsed, register } from "../helpers"

const registerRequest = parsed(register)
if (!isRequest(registerRequest)) throw new Error("Expected a request")
const parsedResponse = createResponse(registerRequest, 200, "OK")

import { acceptsResponse, replyAddress } from "../../src/transport/routing"

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

  it("defaults to the transport's port when sent-by has no port", () => {
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

describe("acceptsResponse (RFC 3261 §18.1.2)", () => {
  const local: Address = { transport: "UDP", host: "192.0.2.10", port: 5060 }
  const ownVia = parseVia("SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK1")
  const reply = (via: ReturnType<typeof parseVia>[]) =>
    ({ ...parsedResponse, via }) as typeof parsedResponse

  it("accepts a response with exactly our own top Via", () => {
    expect(acceptsResponse(reply([ownVia]), local)).toBe(true)
    expect(acceptsResponse(reply([{ ...ownVia, host: "192.0.2.10".toUpperCase() }]), local)).toBe(
      true,
    )
  })

  it.each([
    ["no Via", []],
    ["two Vias", [ownVia, ownVia]],
    ["another host", [{ ...ownVia, host: "192.0.2.11" }]],
    ["another port", [{ ...ownVia, port: 5070 }]],
    ["another transport", [{ ...ownVia, transport: "TCP" }]],
  ])("rejects a response with %s", (_, via) => {
    expect(acceptsResponse(reply(via), local)).toBe(false)
  })
})
