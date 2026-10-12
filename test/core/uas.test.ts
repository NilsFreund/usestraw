import { describe, expect, it } from "vitest"
import { isRequest, type SipRequest } from "../../src/core"
import { answer, checkInvite } from "../../src/core/uas"
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

const allow = { name: "Allow", value: "ACK, BYE, CANCEL, INVITE, OPTIONS" }
const sdp = { name: "Accept", value: "application/sdp" }

describe("answer (RFC 3261 §8.2)", () => {
  it("accepts OPTIONS with 200 and Allow", () => {
    expect(answer(request("OPTIONS"))).toEqual({ status: 200, phrase: "OK", headers: [allow, sdp] })
  })

  it("accepts sips URIs", () => {
    expect(answer(request("OPTIONS", "sips:alice@example.com")).status).toBe(200)
  })

  it.each([
    "INFO",
    "MESSAGE",
    "NOTIFY",
    "PRACK",
    "PUBLISH",
    "REFER",
    "REGISTER",
    "SUBSCRIBE",
    "UPDATE",
  ])("rejects the known method %s with 405 and Allow (§8.2.1)", (method) => {
    expect(answer(request(method))).toEqual({
      status: 405,
      phrase: "Method Not Allowed",
      headers: [allow],
    })
  })

  it.each(["X-CUSTOM", "invite", "FOO"])("rejects the unknown method %s with 501", (method) => {
    expect(answer(request(method))).toEqual({
      status: 501,
      phrase: "Not Implemented",
      headers: [],
    })
  })

  it("rejects a BYE outside any dialog with 481 (§15.1.2)", () => {
    expect(answer(request("BYE"))).toEqual({
      status: 481,
      phrase: "Call/Transaction Does Not Exist",
      headers: [],
    })
  })

  it.each(["CANCEL", "INVITE"])(
    "rejects %s with 481 because it matches no call (§9.2, §12.2.2)",
    (method) => {
      expect(answer(request(method))).toEqual({
        status: 481,
        phrase: "Call/Transaction Does Not Exist",
        headers: [],
      })
    },
  )

  it("rejects unsupported URI schemes with 416", () => {
    expect(answer(request("OPTIONS", "tel:+4930123456"))).toEqual({
      status: 416,
      phrase: "Unsupported URI Scheme",
      headers: [],
    })
  })

  it("rejects OPTIONS with a body with 415 and an empty Accept", () => {
    const options = { ...request("OPTIONS"), body: new Uint8Array([1]) }
    expect(answer(options)).toEqual({
      status: 415,
      phrase: "Unsupported Media Type",
      headers: [{ name: "Accept", value: "" }],
    })
  })

  it("rejects required extensions with 420 and lists them as Unsupported", () => {
    const required = ["Require: 100rel, timer", "Require: replaces"]
    expect(answer(request("OPTIONS", undefined, required))).toEqual({
      status: 420,
      phrase: "Bad Extension",
      headers: [{ name: "Unsupported", value: "100rel, timer, replaces" }],
    })
  })

  it("answers a Require with non-token option tags with 400", () => {
    const required = ['Require: timer, "evil" <x>']
    expect(answer(request("OPTIONS", undefined, required))).toEqual({
      status: 400,
      phrase: "Bad Request",
      headers: [],
    })
  })

  it("ignores an empty Require and Proxy-Require", () => {
    const extra = ["Require: , ", "Proxy-Require: noProxiesSupportThis"]
    expect(answer(request("OPTIONS", undefined, extra)).status).toBe(200)
  })

  it("checks the method before the URI scheme", () => {
    expect(answer(request("MESSAGE", "tel:+4930123456")).status).toBe(405)
  })
})

describe("checkInvite (RFC 3261 §8.2.2–8.2.3)", () => {
  const offer = (type?: string) => ({
    ...request("INVITE", undefined, type === undefined ? [] : [`Content-Type: ${type}`]),
    body: new TextEncoder().encode("v=0\r\n"),
  })

  it("accepts an INVITE without a body or with SDP", () => {
    expect(checkInvite(request("INVITE"))).toBeUndefined()
    expect(checkInvite(offer("application/sdp"))).toBeUndefined()
    expect(checkInvite(offer(" Application/SDP ; charset=utf-8"))).toBeUndefined()
  })

  it.each(["application/sdpx", "multipart/mixed;boundary=x", "text/plain", undefined])(
    "rejects the body type %s with 415 and Accept: application/sdp",
    (type) => {
      expect(checkInvite(offer(type))).toEqual({
        status: 415,
        phrase: "Unsupported Media Type",
        headers: [sdp],
      })
    },
  )

  it("rejects unsupported schemes and required extensions first", () => {
    expect(checkInvite({ ...offer("text/plain"), uri: "tel:+4930123456" })?.status).toBe(416)
    expect(checkInvite(request("INVITE", undefined, ["Require: 100rel"]))).toEqual({
      status: 420,
      phrase: "Bad Extension",
      headers: [{ name: "Unsupported", value: "100rel" }],
    })
    expect(checkInvite(request("INVITE", undefined, ['Require: "x"']))?.status).toBe(400)
  })
})
