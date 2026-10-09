import { describe, expect, it } from "vitest"
import { isRequest, type SipRequest } from "../../src"
import { answer } from "../../src/core/uas"
import { parsed } from "../helpers"

function request(method: string, uri = "sip:alice@example.com", extra: string[] = []): SipRequest {
  const message = parsed(
    [
      `${method} ${uri} SIP/2.0`,
      "Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bK1",
      "From: <sip:bob@example.com>;tag=b1",
      "To: <sip:alice@example.com>",
      "Call-ID: c1",
      `CSeq: 1 ${method}`,
      ...extra,
      "",
      "",
    ].join("\r\n"),
  )
  if (!isRequest(message)) throw new Error("Expected a request")
  return message
}

const allow = { name: "Allow", value: "OPTIONS" }
const idle = { cancelsInvite: false }

describe("answer (RFC 3261 §8.2)", () => {
  it("accepts OPTIONS with 200 and Allow", () => {
    expect(answer(request("OPTIONS"), idle)).toEqual({
      status: 200,
      reason: "OK",
      headers: [allow],
    })
  })

  it("accepts sips URIs", () => {
    expect(answer(request("OPTIONS", "sips:alice@example.com"), idle).status).toBe(200)
  })

  it.each(["INVITE", "BYE", "MESSAGE", "NOTIFY", "REGISTER", "X-CUSTOM"])(
    "rejects %s with 405 and Allow",
    (method) => {
      expect(answer(request(method), idle)).toEqual({
        status: 405,
        reason: "Method Not Allowed",
        headers: [allow],
      })
    },
  )

  it("answers CANCEL for a known INVITE with 200 (RFC 3261 §9.2)", () => {
    expect(answer(request("CANCEL"), { cancelsInvite: true })).toEqual({
      status: 200,
      reason: "OK",
      headers: [],
    })
  })

  it("answers CANCEL without a transaction with 481", () => {
    expect(answer(request("CANCEL"), idle)).toEqual({
      status: 481,
      reason: "Call/Transaction Does Not Exist",
      headers: [],
    })
  })

  it("rejects unsupported URI schemes with 416", () => {
    expect(answer(request("OPTIONS", "tel:+4930123456"), idle)).toEqual({
      status: 416,
      reason: "Unsupported URI Scheme",
      headers: [],
    })
  })

  it("rejects required extensions with 420 and lists them as Unsupported", () => {
    const required = ["Require: 100rel, timer", "Require: replaces"]
    expect(answer(request("OPTIONS", undefined, required), idle)).toEqual({
      status: 420,
      reason: "Bad Extension",
      headers: [{ name: "Unsupported", value: "100rel, timer, replaces" }],
    })
  })

  it("ignores an empty Require and Proxy-Require", () => {
    const extra = ["Require:", "Proxy-Require: noProxiesSupportThis"]
    expect(answer(request("OPTIONS", undefined, extra), idle).status).toBe(200)
  })

  it("checks the method before the URI scheme", () => {
    expect(answer(request("INVITE", "tel:+4930123456"), idle).status).toBe(405)
  })
})
