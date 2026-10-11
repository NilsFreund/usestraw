import { describe, expect, it } from "vitest"
import { getHeader, getHeaders } from "../../src/core"
import { parsed, register } from "../helpers"

describe("getHeader", () => {
  it("looks up headers case-insensitively and by compact name", () => {
    const message = parsed(register.replace("Supported: path, outbound", "k: path\r\nk: outbound"))
    expect(getHeader(message, "SUPPORTED")).toBe("path")
    expect(getHeaders(message, "k")).toEqual(["path", "outbound"])
    expect(getHeader(message, "Allow")).toBeUndefined()
  })

  it("returns typed headers in wire format", () => {
    const message = parsed(register)
    expect(getHeader(message, "Via")).toBe(
      "SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK776asdhds;rport",
    )
    expect(getHeader(message, "f")).toBe('"Bob" <sip:bob@example.com>;tag=456248')
    expect(getHeader(message, "cseq")).toBe("1826 REGISTER")
    expect(getHeaders(message, "Contact")).toEqual(["<sip:bob@192.0.2.4>;expires=7200"])
    expect(getHeader(message, "Content-Length")).toBe("0")
  })
})
