import { describe, expect, it } from "vitest"
import { createResponse } from "../../src"
import { parseAuthParams } from "../../src/auth/params"
import { createAuthenticator } from "../../src/core/authenticator"
import { createRandom } from "../../src/simulation/random"
import { parsedRequest, register } from "../helpers"

const request = parsedRequest(register)
const alice = { username: "alice", password: "secret" }

function challenged(status: 401 | 407, ...challenges: string[]) {
  const name = status === 401 ? "WWW-Authenticate" : "Proxy-Authenticate"
  return createResponse(request, status, "Challenge", {
    headers: challenges.map((value) => ({ name, value })),
  })
}

function params(headers: { name: string; value: string }[], name = "Authorization") {
  const value = headers.find((header) => header.name === name)?.value ?? ""
  return parseAuthParams(value.replace(/^Digest /, "")) ?? new Map()
}

const challenge = (nonce: string, extra = "") =>
  `Digest realm="example.com", nonce="${nonce}", qop="auth"${extra}`

describe("createAuthenticator (RFC 3261 §22)", () => {
  it("adds nothing before the first challenge", () => {
    expect(createAuthenticator(alice, createRandom(1)).authorize(request)).toStrictEqual([])
  })

  it("answers a 401 with Authorization and counts nonces up", () => {
    const authenticator = createAuthenticator(alice, createRandom(1))
    expect(authenticator.challenge(challenged(401, challenge("n1")))).toBeUndefined()
    const first = params(authenticator.authorize(request))
    const second = params(authenticator.authorize(request))
    expect(first.get("username")).toBe("alice")
    expect(first.get("uri")).toBe(request.uri)
    expect([first.get("nc"), second.get("nc")]).toStrictEqual(["00000001", "00000002"])
    expect(second.get("cnonce")).toBe(first.get("cnonce"))
    expect(first.get("cnonce")).toMatch(/^[a-z0-9]{16}$/)
  })

  it("answers a 407 with Proxy-Authorization and keeps both after a later 401", () => {
    const authenticator = createAuthenticator(alice, createRandom(1))
    authenticator.challenge(challenged(407, challenge("proxy")))
    authenticator.challenge(challenged(401, challenge("registrar")))
    const headers = authenticator.authorize(request)
    expect(headers.map((header) => header.name)).toStrictEqual([
      "Proxy-Authorization",
      "Authorization",
    ])
    expect(params(headers, "Proxy-Authorization").get("nonce")).toBe("proxy")
  })

  it("reports a missing account", () => {
    expect(
      createAuthenticator(undefined, createRandom(1)).challenge(challenged(401, challenge("n"))),
    ).toStrictEqual({
      reason: "no-credentials",
    })
  })

  it("lists what was offered when nothing is supported", () => {
    const failure = createAuthenticator(alice, createRandom(1)).challenge(
      challenged(401, 'Digest realm="r", nonce="n", algorithm=SHA-1', 'Basic realm="r"', "Digest"),
    )
    expect(failure).toStrictEqual({
      reason: "unsupported-challenge",
      offered: [
        { scheme: "Digest", realm: "r", algorithm: "SHA-1" },
        { scheme: "Basic" },
        { scheme: "Digest" },
      ],
    })
  })

  it("only answers the configured realm", () => {
    const authenticator = createAuthenticator({ ...alice, realm: "other" }, createRandom(1))
    expect(authenticator.challenge(challenged(401, challenge("n")))).toStrictEqual({
      reason: "unsupported-challenge",
      offered: [{ scheme: "Digest", realm: "example.com", algorithm: "MD5" }],
    })
  })

  it("stops when sent credentials are challenged again (RFC 3261 §22.1)", () => {
    const authenticator = createAuthenticator(alice, createRandom(1))
    authenticator.challenge(challenged(401, challenge("n1")))
    authenticator.authorize(request)
    expect(authenticator.challenge(challenged(401, challenge("n2")))).toStrictEqual({
      reason: "unauthorized",
      status: 401,
    })
  })

  it("retries a stale nonce with a fresh cnonce and count", () => {
    const authenticator = createAuthenticator(alice, createRandom(1))
    authenticator.challenge(challenged(401, challenge("n1")))
    const first = params(authenticator.authorize(request))
    expect(
      authenticator.challenge(challenged(401, challenge("n2", ", stale=true"))),
    ).toBeUndefined()
    const second = params(authenticator.authorize(request))
    expect(second.get("nonce")).toBe("n2")
    expect(second.get("nc")).toBe("00000001")
    expect(second.get("cnonce")).not.toBe(first.get("cnonce"))
  })

  it("keeps the cnonce and counts on when a stale challenge repeats the nonce", () => {
    const authenticator = createAuthenticator(alice, createRandom(1))
    authenticator.challenge(challenged(401, challenge("n1")))
    const first = params(authenticator.authorize(request))
    authenticator.challenge(challenged(401, challenge("n1", ", stale=true")))
    const second = params(authenticator.authorize(request))
    expect(second.get("nc")).toBe("00000002")
    expect(second.get("cnonce")).toBe(first.get("cnonce"))
  })

  it("gives up after three stale challenges in a row", () => {
    const authenticator = createAuthenticator(alice, createRandom(1))
    const outcomes = [1, 2, 3, 4].map((round) => {
      const outcome = authenticator.challenge(
        challenged(401, challenge(`n${round}`, ", stale=true")),
      )
      authenticator.authorize(request)
      return outcome?.reason
    })
    expect(outcomes).toStrictEqual([undefined, undefined, undefined, "unauthorized"])
  })

  it("forgets everything on reset", () => {
    const authenticator = createAuthenticator(alice, createRandom(1))
    authenticator.challenge(challenged(401, challenge("n1")))
    authenticator.authorize(request)
    authenticator.reset()
    expect(authenticator.authorize(request)).toStrictEqual([])
    expect(authenticator.challenge(challenged(401, challenge("n2")))).toBeUndefined()
  })
})
