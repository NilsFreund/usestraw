import { describe, expect, it } from "vitest"
import { parseChallenge } from "../../src/auth/challenge"
import { resolveOffer } from "../../src/auth/offer"

function resolve(params: string) {
  const challenge = parseChallenge(`Digest realm="r", nonce="n", ${params}`)
  if (!challenge) throw new Error(`Invalid challenge ${params}`)
  const offer = resolveOffer(challenge)
  return (
    offer && { algorithm: offer.algorithm.name, session: offer.algorithm.session, qop: offer.qop }
  )
}

describe("resolveOffer", () => {
  it.each([
    ["qop=auth", { algorithm: "MD5", session: false, qop: "auth" }],
    ['qop="auth-int, auth"', { algorithm: "MD5", session: false, qop: "auth" }],
    ['qop="auth-int"', { algorithm: "MD5", session: false, qop: "auth-int" }],
    ['algorithm=sha-256, qop="AUTH"', { algorithm: "SHA-256", session: false, qop: "auth" }],
  ])("resolves %s", (params, expected) => {
    expect(resolve(params)).toStrictEqual(expected)
  })

  it("keeps RFC 2069 mode for plain MD5 without qop", () => {
    expect(resolve("algorithm=MD5")).toStrictEqual({
      algorithm: "MD5",
      session: false,
      qop: undefined,
    })
    expect(
      resolveOffer({ realm: "r", nonce: "n", qop: [], stale: false, userhash: false })?.qop,
    ).toBeUndefined()
  })

  it.each(["algorithm=MD5-sess", "algorithm=SHA-256", "algorithm=SHA-512-256-sess"])(
    "treats a missing qop as auth for %s (RFC 8760 §2.6 item 8)",
    (params) => {
      expect(resolve(params)?.qop).toBe("auth")
    },
  )

  it.each(["algorithm=SHA-1", 'qop="auth-conf"', "algorithm=\u017fHA-256"])(
    "refuses %s",
    (params) => {
      expect(resolve(params)).toBeUndefined()
    },
  )
})
