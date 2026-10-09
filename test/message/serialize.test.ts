import { describe, expect, it } from "vitest"
import { createResponse, isRequest, serializeMessage } from "../../src"
import { parsed, register } from "../helpers"

describe("serializeMessage", () => {
  it("writes canonical headers in a stable order", () => {
    expect(new TextDecoder().decode(serializeMessage(parsed(register)))).toBe(
      [
        "REGISTER sip:example.com SIP/2.0",
        "Via: SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK776asdhds;rport",
        "Max-Forwards: 70",
        'From: "Bob" <sip:bob@example.com>;tag=456248',
        'To: "Bob" <sip:bob@example.com>',
        "Call-ID: 843817637684230@998sdasdh09",
        "CSeq: 1826 REGISTER",
        "Contact: <sip:bob@192.0.2.4>;expires=7200",
        "Supported: path, outbound",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"),
    )
  })

  it("appends the body and sets Content-Length from it", () => {
    const body = new TextEncoder().encode("v=0\r\n")
    const text = new TextDecoder().decode(serializeMessage({ ...parsed(register), body }))
    expect(text).toContain("Content-Length: 5\r\n\r\nv=0\r\n")
  })

  it("refuses messages that would inject headers", () => {
    const request = parsed(register)
    if (!isRequest(request)) throw new Error("Expected a request")
    const response = createResponse(request, 200, "OK\r\nX-Injected: yes")
    expect(() => serializeMessage(response)).toThrow(TypeError)
  })

  it("catches values that change between validation and formatting", () => {
    const request = parsed(register)
    let reads = 0
    const shifty = Object.defineProperty({ ...request }, "callId", {
      get: () => (reads++ === 0 ? "abc" : "abc\r\nX-Injected: 1"),
    })
    expect(() => serializeMessage(shifty)).toThrow(
      new TypeError('Line break in "Call-ID: abc\\r\\nX-Injected: 1"'),
    )
  })

  it("round-trips escaped control characters in display names", () => {
    const message = parsed(register.replace("To: Bob", 'To: "BEL:\\\x07 NUL:\\\x00"'))
    const again = parsed(serializeMessage(message))
    expect(again.to.displayName).toBe("BEL:\x07 NUL:\x00")
  })
})
