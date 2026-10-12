import { describe, expect, it } from "vitest"
import type { AuthChallenge } from "../../src/core"
import { ConnectError } from "../../src/phone/connect-error"
import { type PhoneFailure, toConnectError } from "../../src/phone/failures"

const context = { label: "tls://sip.example.com:5061", username: "alice" }

describe("ConnectError", () => {
  it.each<[PhoneFailure, string, number | undefined]>([
    [{ reason: "unauthorized", status: 407 }, "wrong-password", 407],
    [{ reason: "no-credentials" }, "password-missing", undefined],
    [{ reason: "unsupported-challenge", offered: [] }, "unsupported-auth", undefined],
    [{ reason: "rejected", status: 403, phrase: "Forbidden" }, "refused", 403],
    [{ reason: "rejected", status: 404, phrase: "Not Found" }, "refused", 404],
    [{ reason: "rejected", status: 503, phrase: "Busy" }, "unavailable", 503],
    [{ reason: "rejected", status: 408, phrase: "Timeout" }, "unavailable", 408],
    [{ reason: "not-bound" }, "refused", undefined],
    [{ reason: "timeout" }, "no-answer", undefined],
    [{ reason: "network" }, "network", undefined],
  ])("names %j in app words", (failure, reason, status) => {
    const error = toConnectError(failure, context)
    expect(error.reason).toBe(reason)
    expect(error.sip).toStrictEqual(status === undefined ? undefined : { status })
  })

  it("can be built from plain data, for example after crossing a MessagePort", () => {
    const cause = new Error("gone")
    const error = new ConnectError("Network error", {
      reason: "network",
      sip: { status: 503 },
      cause,
    })
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      name: "ConnectError",
      message: "Network error",
      reason: "network",
    })
    expect(error.sip).toStrictEqual({ status: 503 })
    expect(error.cause).toBe(cause)
    expect("cause" in new ConnectError("x", { reason: "refused" })).toBe(false)
  })

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
      "tls://sip.example.com:5061 accepted the registration but did not keep it: a NAT or SIP ALG may have rewritten our address",
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
      'tls://sip.example.com:5061 refused the password for "alice" with 401: check the password, or pass authUser if your provider uses a separate auth user',
    ],
    [
      { reason: "network" },
      "Network error with tls://sip.example.com:5061: the server closed the connection",
    ],
  ])("explains %j", (failure, message) => {
    const error = toConnectError(failure, context)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("ConnectError")
    expect(error.message).toBe(message)
    expect("cause" in error).toBe(false)
  })

  it("keeps the network error as its cause", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 192.0.2.1:5061"), {
      code: "ECONNREFUSED",
    })
    const error = toConnectError({ reason: "network" }, context, cause)
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
    expect(toConnectError({ reason: "network" }, context, cause).message).toBe(
      "Network error with tls://sip.example.com:5061: untrusted (pass tls.ca if the server uses a private CA)",
    )
  })

  it("escapes and cuts what the server sent", () => {
    const phrase = `For‮bidden\u009b${"x".repeat(2000)}`
    const offered = Array.from({ length: 50 }, (_, index) => ({ scheme: `S ${index}` }))
    const rejected = toConnectError({ reason: "rejected", status: 403, phrase }, context)
    const unsupported = toConnectError({ reason: "unsupported-challenge", offered }, context)
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
    expect(toConnectError({ reason: "unsupported-challenge", offered }, context).message).toBe(
      `tls://sip.example.com:5061 asks for authentication Straw does not support: ${list}`,
    )
  })

  it("names the realms offered when none is the realm it was given", () => {
    const pinned = { ...context, realm: "example.com" }
    const offer = (realm: string) => ({ scheme: "Digest", algorithm: "MD5", realm })
    const explain = (offered: AuthChallenge[]) =>
      toConnectError({ reason: "unsupported-challenge", offered }, pinned).message
    expect(
      explain([offer("corp.example"), offer("corp.example"), offer("b"), offer("c"), offer("d")]),
    ).toBe(
      'tls://sip.example.com:5061 asks for authentication in realm "corp.example", "b", "c", …, not "example.com": check realm',
    )
    expect(explain([offer("example.com")])).toBe(
      'tls://sip.example.com:5061 asks for authentication Straw does not support: "Digest MD5"',
    )
    expect(explain([{ scheme: "Bearer" }])).toBe(
      'tls://sip.example.com:5061 asks for authentication Straw does not support: "Bearer"',
    )
  })

  it("escapes the username", () => {
    const error = toConnectError(
      { reason: "unauthorized", status: 403 },
      { ...context, username: "a‮b" },
    )
    expect(error.message).toContain('"a\\u202eb"')
  })
})
