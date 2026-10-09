import { describe, expect, it } from "vitest"
import { parseChallenge } from "../../src/auth/challenge"

describe("parseChallenge", () => {
  it("parses the RFC 3261 §20.44 example", () => {
    expect(
      parseChallenge(
        'Digest realm="atlanta.com", domain="sip:boxesbybob.com", qop="auth", nonce="f84f1cec41e6cbe5aea9c8e88d359", opaque="", stale=FALSE, algorithm=MD5',
      ),
    ).toStrictEqual({
      realm: "atlanta.com",
      nonce: "f84f1cec41e6cbe5aea9c8e88d359",
      algorithm: "MD5",
      qop: ["auth"],
      opaque: "",
      stale: false,
      userhash: false,
    })
  })

  it("leaves out what the server did not send", () => {
    expect(parseChallenge('Digest realm="r", nonce="n"')).toStrictEqual({
      realm: "r",
      nonce: "n",
      qop: [],
      stale: false,
      userhash: false,
    })
  })

  it("normalizes the qop list and reads flags case-insensitively", () => {
    expect(
      parseChallenge(
        'digest realm="r", nonce="n", qop=" Auth ,auth-int,", stale=TRUE, userhash=True',
      ),
    ).toMatchObject({ qop: ["auth", "auth-int"], stale: true, userhash: true })
  })

  it("accepts a tab after the scheme and a line separator inside a quoted value", () => {
    expect(parseChallenge('Digest\trealm="a\u2028b", nonce="n"')?.realm).toBe("a\u2028b")
  })

  it("accepts realm, nonce and opaque up to 1024 characters", () => {
    const long = "x".repeat(1024)
    expect(
      parseChallenge(`Digest realm="${long}", nonce="${long}", opaque="${long}"`),
    ).toBeDefined()
  })

  it.each([
    ["the Basic scheme", 'Basic realm="r"'],
    ["leading whitespace", ' Digest realm="r", nonce="n"'],
    ["a realm above 1024 characters", `Digest realm="${"x".repeat(1025)}", nonce="n"`],
    ["a nonce above 1024 characters", `Digest realm="r", nonce="${"x".repeat(1025)}"`],
    [
      "an opaque above 1024 characters",
      `Digest realm="r", nonce="n", opaque="${"x".repeat(1025)}"`,
    ],
    ["a scheme without parameters", "Digest"],
    ["a missing realm", 'Digest nonce="n"'],
    ["a missing nonce", 'Digest realm="r"'],
    ["malformed parameters", 'Digest realm="r", nonce'],
    ["an unterminated quote", 'Digest realm="r, nonce="n'],
    ["a scheme glued to its parameters", 'Digestrealm="r", nonce="n"'],
  ])("ignores %s", (_, value) => {
    expect(parseChallenge(value)).toBeUndefined()
  })
})
