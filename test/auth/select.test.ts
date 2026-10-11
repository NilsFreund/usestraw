import { describe, expect, it } from "vitest"
import { selectOffer } from "../../src/auth/select"

const nonce = (values: string[], realm?: string) =>
  selectOffer(values, realm === undefined ? undefined : new Map([[realm, 0]]))?.challenge.nonce

describe("selectOffer (RFC 8760 §2.4)", () => {
  it("takes the strongest offer of a realm wherever it is listed", () => {
    const values = [
      'Digest realm="r", nonce="md5", algorithm=MD5, qop="auth"',
      'Digest realm="r", nonce="sha512", algorithm=SHA-512-256, qop="auth"',
      'Digest realm="r", nonce="sha256", algorithm=SHA-256, qop="auth"',
    ]
    expect(nonce(values)).toBe("sha512")
  })

  it("cannot be downgraded to RFC 2069 by an injected MD5 challenge", () => {
    const values = [
      'Digest realm="r", nonce="evil", algorithm=MD5',
      'Digest realm="r", nonce="good", algorithm=MD5, qop="auth"',
    ]
    expect(nonce(values)).toBe("good")
  })

  it("keeps the topmost offer among equals", () => {
    const values = [
      'Digest realm="r", nonce="1", qop="auth"',
      'Digest realm="r", nonce="2", qop="auth"',
    ]
    expect(nonce(values)).toBe("1")
  })

  it("answers only the realm of the first supported challenge", () => {
    const values = [
      'Digest realm="r", nonce="unsupported", algorithm=SHA-1',
      'Digest realm="proxy", nonce="1", qop="auth"',
      'Digest realm="registrar", nonce="2", algorithm=SHA-256, qop="auth"',
    ]
    expect(selectOffer(values)?.challenge.realm).toBe("proxy")
  })

  it("answers the configured realm only", () => {
    const values = ['Digest realm="proxy", nonce="1"', 'Digest realm="registrar", nonce="2"']
    expect(nonce(values, "registrar")).toBe("2")
    expect(nonce(values, "elsewhere")).toBeUndefined()
  })

  it("ignores what it cannot answer", () => {
    expect(selectOffer(['Basic realm="r"', "Digest garbage", ""])).toBeUndefined()
  })
})
