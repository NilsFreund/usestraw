import { describe, expect, it } from "vitest"
import { type PhoneFailure, RegistrationError } from "../../src/node/errors"

const context = { label: "tls://sip.example.com:5061", username: "alice" }

describe("RegistrationError", () => {
  it.each<[PhoneFailure, string]>([
    [
      { reason: "timeout" },
      "No answer from tls://sip.example.com:5061: check the host, port and transport",
    ],
    [
      { reason: "rejected", status: 403, phrase: "Forbidden" },
      'tls://sip.example.com:5061 rejected the registration with 403 "Forbidden"',
    ],
    [
      { reason: "not-bound" },
      "tls://sip.example.com:5061 accepted the registration but kept no binding",
    ],
    [
      { reason: "no-credentials" },
      "tls://sip.example.com:5061 asks for a password, but none was given",
    ],
    [
      {
        reason: "unsupported-challenge",
        offered: [{ scheme: "Digest", algorithm: "SHA-1" }, { scheme: "Bearer" }],
      },
      'tls://sip.example.com:5061 asks for authentication Straw does not support: "Digest SHA-1", "Bearer"',
    ],
    [
      { reason: "unsupported-challenge", offered: [] },
      "tls://sip.example.com:5061 asks for authentication Straw does not support: no challenge",
    ],
    [
      { reason: "unauthorized", status: 401 },
      'tls://sip.example.com:5061 refused the password for "alice" with 401: check the password, or pass username if your provider uses a separate auth user',
    ],
    [
      { reason: "network" },
      "Network error with tls://sip.example.com:5061: the server closed the connection",
    ],
  ])("explains %j", (failure, message) => {
    const error = new RegistrationError(failure, context)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("RegistrationError")
    expect(error.message).toBe(message)
    expect(error.failure).toBe(failure)
    expect("cause" in error).toBe(false)
  })

  it("keeps the network error as its cause", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 192.0.2.1:5061"), {
      code: "ECONNREFUSED",
    })
    const error = new RegistrationError({ reason: "network" }, context, cause)
    expect(error.cause).toBe(cause)
    expect(error.message).toBe(
      "Network error with tls://sip.example.com:5061: connect ECONNREFUSED 192.0.2.1:5061",
    )
  })

  it.each([
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  ])("points to tls.ca for %s", (code) => {
    const cause = Object.assign(new Error("untrusted"), { code })
    expect(new RegistrationError({ reason: "network" }, context, cause).message).toBe(
      "Network error with tls://sip.example.com:5061: untrusted (pass tls.ca if the server uses a private CA)",
    )
  })

  it("escapes and cuts what the server sent", () => {
    const phrase = `For‮bidden\u009b${"x".repeat(2000)}`
    const offered = Array.from({ length: 50 }, (_, index) => ({ scheme: `S ${index}` }))
    const rejected = new RegistrationError({ reason: "rejected", status: 403, phrase }, context)
    const unsupported = new RegistrationError({ reason: "unsupported-challenge", offered }, context)
    expect(rejected.message).toMatch(/^[\x20-\x7e]+$/)
    expect(rejected.message.length).toBeLessThan(200)
    expect(rejected.message).toContain("For\\u202ebidden\\u009b")
    expect(unsupported.message).toBe(
      'tls://sip.example.com:5061 asks for authentication Straw does not support: "S\\u20280", "S\\u20281", "S\\u20282", …',
    )
  })

  it.each([
    [3, '"S0", "S1", "S2"'],
    [4, '"S0", "S1", "S2", …'],
  ])("lists at most three of %i offers", (count, list) => {
    const offered = Array.from({ length: count }, (_, index) => ({ scheme: `S${index}` }))
    expect(
      new RegistrationError({ reason: "unsupported-challenge", offered }, context).message,
    ).toBe(`tls://sip.example.com:5061 asks for authentication Straw does not support: ${list}`)
  })

  it("escapes the username", () => {
    const error = new RegistrationError(
      { reason: "unauthorized", status: 403 },
      { ...context, username: "a‮b" },
    )
    expect(error.message).toContain('"a\\u202eb"')
  })
})
