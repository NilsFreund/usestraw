import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { createResponse, isRequest, type SipMessage, type SipRequest } from "../../src"
import { validateMessage } from "../../src/message/validate"
import { parsed, register } from "../helpers"

function request(): SipRequest {
  const message = parsed(register)
  if (!isRequest(message)) throw new Error("Expected a request")
  return message
}

const valid = request()
const response = createResponse(valid, 200, "OK", { toTag: "t1" })

describe("validateMessage", () => {
  it.each([
    ["a parsed request", valid],
    ["a response", response],
    ["a response with an empty reason", { ...response, reason: "" }],
    ["a tab in a header value", { ...valid, headers: [{ name: "Subject", value: "a\tb" }] }],
    ["a wildcard Contact", { ...valid, contact: "*" as const }],
    ["a message without Max-Forwards", { ...response, maxForwards: undefined }],
    ["a body from another realm", { ...valid, body: runInNewContext("new Uint8Array(3)") }],
    [
      "an escaped NUL in a quoted header value",
      { ...valid, headers: [{ name: "X", value: '"\\\x00"' }] },
    ],
  ] as [string, SipMessage][])("accepts %s", (_, message) => {
    expect(() => validateMessage(message)).not.toThrow()
  })

  it.each([
    ["a bad method", { ...valid, method: "INVITE\r\nX: y" }, 'Invalid method "INVITE\\r\\nX: y"'],
    [
      "a bad Request-URI",
      { ...valid, uri: "sip:a SIP/2.0\r\nX: y" },
      'Invalid Request-URI "sip:a SIP/2.0\\r\\nX: y"',
    ],
    [
      "URI headers in the Request-URI",
      { ...valid, uri: "sip:a@b?Route=x" },
      'Invalid Request-URI "sip:a@b?Route=x"',
    ],
    [
      "a CSeq method mismatch",
      { ...valid, cseq: { seq: 1, method: "INVITE" } },
      'CSeq method "INVITE" does not match "REGISTER"',
    ],
    ["a status below 100", { ...response, status: 99 }, "Invalid status code 99"],
    ["a fractional status", { ...response, status: 200.5 }, "Invalid status code 200.5"],
    ["a status above 699", { ...response, status: 700 }, "Invalid status code 700"],
    [
      "a reason with CRLF",
      { ...response, reason: "OK\r\nX: y" },
      'Invalid reason phrase "OK\\r\\nX: y"',
    ],
    ["a reason with NUL", { ...response, reason: "O\x00K" }, 'Invalid reason phrase "O\\u0000K"'],
    ["no Via", { ...valid, via: [] }, "Missing Via"],
    ["a bad top Via", { ...valid, via: [{ ...valid.via[0], host: "a\r\nb" }] }, "Invalid Via"],
    [
      "a bad lower Via",
      { ...valid, via: [...valid.via, { transport: "UDP", host: "a b", params: new Map() }] },
      "Invalid Via",
    ],
    ["a bad From", { ...valid, from: { ...valid.from, displayName: "a\r\nb" } }, "Invalid From"],
    [
      "a bad To",
      { ...valid, to: { ...valid.to, params: new Map([["tag", "a\nb"]]) } },
      "Invalid To",
    ],
    ["a Call-ID with CRLF", { ...valid, callId: "a\r\nX: y" }, 'Invalid Call-ID "a\\r\\nX: y"'],
    ["a Call-ID with NUL", { ...valid, callId: "a\x00b" }, 'Invalid Call-ID "a\\u0000b"'],
    ["an empty Call-ID", { ...valid, callId: "" }, 'Invalid Call-ID ""'],
    ["a bad CSeq", { ...valid, cseq: { seq: -1, method: "REGISTER" } }, "Invalid CSeq"],
    ["Max-Forwards above 255", { ...valid, maxForwards: 256 }, "Invalid Max-Forwards 256"],
    [
      "a bad Contact",
      { ...valid, contact: [{ uri: "x\r\ny", params: new Map() }] },
      "Invalid Contact",
    ],
    [
      "a header name with space",
      { ...valid, headers: [{ name: "X Y", value: "1" }] },
      'Invalid header name "X Y"',
    ],
    [
      "Via as header",
      { ...valid, headers: [{ name: "Via", value: "SIP/2.0/UDP x" }] },
      'Set "Via" through its message field, not as a header',
    ],
    [
      "a compact typed header",
      { ...valid, headers: [{ name: "l", value: "0" }] },
      'Set "l" through its message field, not as a header',
    ],
    [
      "Content-Length as header",
      { ...valid, headers: [{ name: "content-length", value: "9" }] },
      'Set "content-length" through its message field, not as a header',
    ],
    [
      "a header value with CRLF",
      { ...valid, headers: [{ name: "X", value: "a\r\nVia: evil" }] },
      'Invalid X value "a\\r\\nVia: evil"',
    ],
    [
      "a header value with raw NUL",
      { ...valid, headers: [{ name: "X", value: "a\x00b" }] },
      'Invalid X value "a\\u0000b"',
    ],
    [
      "an escaped CR",
      { ...valid, headers: [{ name: "X", value: '"\\\r"' }] },
      'Invalid X value "\\"\\\\\\r\\""',
    ],
  ] as [string, SipMessage, string][])("rejects %s", (_, message, error) => {
    expect(() => validateMessage(message)).toThrow(new TypeError(error))
  })

  describe("values smuggled past the types", () => {
    const sneaky = (text: string) => ({ toString: () => text }) as unknown as string
    const flipping = () => {
      let calls = 0
      return { toString: () => (calls++ === 0 ? "token" : "x\r\nEvil: 1") } as unknown as string
    }

    it.each([
      ["a header value", { ...valid, headers: [{ name: "X", value: sneaky("ok\r\nEvil: 1") }] }],
      ["a harmless header value", { ...valid, headers: [{ name: "X", value: sneaky("ok") }] }],
      ["a header name", { ...valid, headers: [{ name: sneaky("X"), value: "1" }] }],
      ["a method", { ...valid, method: sneaky("REGISTER") }],
      ["a Request-URI", { ...valid, uri: sneaky("sip:example.com") }],
      ["a reason", { ...response, reason: sneaky("OK") }],
      ["a Call-ID", { ...valid, callId: sneaky("abc") }],
      ["a display name", { ...valid, from: { ...valid.from, displayName: sneaky("Bob") } }],
      ["a Via host", { ...valid, via: [{ ...valid.via[0], host: sneaky("192.0.2.1") }] }],
      [
        "a parameter value",
        { ...valid, to: { ...valid.to, params: new Map([["tag", flipping()]]) } },
      ],
      ["a body", { ...valid, body: "v=0" as unknown as Uint8Array }],
    ] as [string, SipMessage][])("rejects a non-string %s", (_, message) => {
      expect(() => validateMessage(message)).toThrow(TypeError)
    })
  })
})
