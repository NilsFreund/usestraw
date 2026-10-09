import { describe, expect, it } from "vitest"
import { formatAuthorization } from "../../src/auth/authorization"
import type { Credentials } from "../../src/auth/digest"

const base: Credentials = {
  username: "bob",
  realm: "biloxi.com",
  nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
  uri: "sip:bob@biloxi.com",
  response: "6629fae49393a05397450978507c4ef1",
  userhash: false,
}

describe("formatAuthorization (RFC 3261 §22.4, RFC 8760 §2.6)", () => {
  it("quotes username, realm, nonce, uri and response", () => {
    expect(formatAuthorization(base)).toBe(
      'Digest username="bob", realm="biloxi.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", uri="sip:bob@biloxi.com", response="6629fae49393a05397450978507c4ef1"',
    )
  })

  it("adds algorithm, qop, nc, cnonce, opaque and userhash with the right quoting", () => {
    const value = formatAuthorization({
      ...base,
      algorithm: "SHA-256",
      opaque: "5ccc069c403ebaf9f0171e9517f40e41",
      protection: { qop: "auth", nc: "00000001", cnonce: "0a4f113b" },
      userhash: true,
    })
    expect(value).toBe(
      'Digest username="bob", realm="biloxi.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", uri="sip:bob@biloxi.com", response="6629fae49393a05397450978507c4ef1", algorithm=SHA-256, qop=auth, nc=00000001, cnonce="0a4f113b", opaque="5ccc069c403ebaf9f0171e9517f40e41", userhash=true',
    )
  })

  it("escapes quotes and backslashes coming from the server and keeps an empty opaque", () => {
    expect(formatAuthorization({ ...base, nonce: 'a"b\\c', opaque: "" })).toBe(
      'Digest username="bob", realm="biloxi.com", nonce="a\\"b\\\\c", uri="sip:bob@biloxi.com", response="6629fae49393a05397450978507c4ef1", opaque=""',
    )
  })

  it.each(["username", "realm", "nonce", "uri", "response", "opaque"] as const)(
    "refuses a line break in the %s",
    (field) => {
      expect(() => formatAuthorization({ ...base, [field]: "a\r\nX: y" })).toThrow(TypeError)
    },
  )
})
