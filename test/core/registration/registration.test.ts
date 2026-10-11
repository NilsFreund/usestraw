import { describe, expect, it } from "vitest"
import {
  type Credentials,
  createResponse,
  getHeader,
  type SipHeader,
  type SipRequest,
} from "../../../src"
import { createTrust } from "../../../src/core/authenticator"
import { createRegistration } from "../../../src/core/registration/registration"
import type { RegistrationOutput } from "../../../src/core/registration/types"
import { createRandom } from "../../../src/simulation/random"
import { alice, bob } from "../../helpers"

const account: Credentials = { username: "alice", password: "secret" }
const intent = { to: bob, registrar: "sip:example.com", expires: 3600 }

function setup(credentials?: Credentials, seed = 1, trust = createTrust()) {
  const identity = { address: alice, aor: "sip:alice@example.com", random: createRandom(seed) }
  return createRegistration(identity, trust, credentials)
}

function sent(outputs: RegistrationOutput[]): SipRequest {
  const [output] = outputs
  if (output?.type !== "send") throw new Error("Expected a request")
  return output.request
}

function events(outputs: RegistrationOutput[]) {
  return outputs.flatMap((output) => (output.type === "event" ? [output.event] : []))
}

function reply(request: SipRequest, status: number, headers: SipHeader[] = [], reason = "Reason") {
  return {
    type: "response",
    response: createResponse(request, status, reason, { headers }),
    from: bob,
  } as const
}

const challenge = (nonce = "n1", name = "WWW-Authenticate") => ({
  name,
  value: `Digest realm="example.com", nonce="${nonce}", qop="auth"`,
})

function requestIn(outputs: RegistrationOutput[]): SipRequest {
  const output = outputs.find((entry) => entry.type === "send")
  if (output?.type !== "send") throw new Error("Expected a request")
  return output.request
}

function natted(request: SipRequest, status = 200, port = "33172") {
  const answer = reply(request, status, status === 200 ? [] : [challenge("nat")])
  const [via, ...rest] = answer.response.via
  if (!via) throw new Error("No Via")
  const seen = new Map([...via.params, ["received", "203.0.113.1"], ["rport", port]])
  return { ...answer, response: { ...answer.response, via: [{ ...via, params: seen }, ...rest] } }
}

describe("createRegistration behind a NAT (RFC 3581)", () => {
  it("registers again where the registrar saw it and drops the private binding at once", () => {
    const registration = setup(account)
    const first = sent(registration.register(intent))
    const outputs = registration.receive(natted(first), 0)
    expect(events(outputs)).toStrictEqual([
      { type: "registration", state: "registered", expires: 3600 },
    ])
    const moved = requestIn(outputs)
    expect(moved.contact).toStrictEqual([
      { uri: "sip:alice@203.0.113.1:33172", params: new Map() },
      { uri: "sip:alice@192.0.2.10:5060", params: new Map([["expires", "0"]]) },
    ])
    expect(registration.contact.uri).toBe("sip:alice@203.0.113.1:33172")
    const challenged = sent(registration.receive(natted(moved, 401), 10))
    expect(challenged.contact).toStrictEqual(moved.contact)
    expect(getHeader(challenged, "Authorization")).toMatch(/^Digest /)
    const settled = registration.receive(natted(challenged), 20)
    expect(events(settled)).toMatchObject([{ state: "registered" }])
    expect(settled.filter((output) => output.type === "send")).toStrictEqual([])
    const refresh = sent(registration.expire(Number.MAX_SAFE_INTEGER))
    expect(refresh.contact).toStrictEqual([
      { uri: "sip:alice@203.0.113.1:33172", params: new Map() },
    ])
  })

  it("registers plainly once more when the registrar lost the new binding, as a SIP ALG causes", () => {
    const registration = setup(account)
    const moved = requestIn(registration.receive(natted(sent(registration.register(intent))), 0))
    const answer = natted(moved)
    const others = [{ uri: "sip:alice@192.0.2.10:5060", params: new Map([["expires", "60"]]) }]
    const plain = requestIn(
      registration.receive({ ...answer, response: { ...answer.response, contact: others } }, 10),
    )
    expect(plain.contact).toStrictEqual([{ uri: "sip:alice@203.0.113.1:33172", params: new Map() }])
  })

  it("goes back to its own Contact for good when the registrar refuses the public one", () => {
    const registration = setup(account)
    const moved = requestIn(registration.receive(natted(sent(registration.register(intent))), 0))
    const back = sent(registration.receive(natted(moved, 403), 10))
    expect(back.contact).toStrictEqual([{ uri: "sip:alice@192.0.2.10:5060", params: new Map() }])
    const settled = registration.receive(natted(back), 20)
    expect(settled.filter((output) => output.type === "send")).toStrictEqual([])
    expect(registration.contact.uri).toBe("sip:alice@192.0.2.10:5060")
  })

  it("keeps dropping the private binding when it retries, and moves at most once in a row", () => {
    const registration = setup(account)
    const moved = requestIn(registration.receive(natted(sent(registration.register(intent))), 0))
    registration.receive(natted(moved, 503), 10)
    const retry = sent(registration.expire(Number.MAX_SAFE_INTEGER))
    expect(retry.contact).toStrictEqual(moved.contact)
    const settled = registration.receive(natted(retry, 200, "40000"), 20)
    expect(settled.filter((output) => output.type === "send")).toStrictEqual([])
  })

  it("follows the NAT when it hands out a new port", () => {
    const registration = setup(account)
    const first = sent(registration.register(intent))
    const moved = requestIn(registration.receive(natted(first), 0))
    registration.receive(natted(moved), 10)
    const refresh = sent(registration.expire(Number.MAX_SAFE_INTEGER))
    const again = requestIn(registration.receive(natted(refresh, 200, "40000"), 20))
    expect(again.contact).toMatchObject([
      { uri: "sip:alice@203.0.113.1:40000" },
      { uri: "sip:alice@203.0.113.1:33172" },
    ])
  })
})

describe("createRegistration", () => {
  it("sends the REGISTER it was asked for", () => {
    const request = sent(setup(account).register(intent))
    expect(request).toMatchObject({ method: "REGISTER", uri: "sip:example.com", cseq: { seq: 1 } })
    expect(getHeader(request, "Expires")).toBe("3600")
    expect(getHeader(request, "Supported")).toBe("path")
  })

  it("reports the granted expiry and refreshes around half of it", () => {
    const registration = setup(account)
    const request = sent(registration.register({ ...intent, expires: 600 }))
    const contact = [{ uri: "sip:alice@192.0.2.10:5060", params: new Map([["expires", "300"]]) }]
    const granted = { ...reply(request, 200).response, contact }
    expect(
      events(registration.receive({ type: "response", response: granted, from: bob }, 1000)),
    ).toStrictEqual([{ type: "registration", state: "registered", expires: 300 }])
    const at = registration.nextDeadline() ?? 0
    expect(at).toBeGreaterThanOrEqual(1000 + 135_000)
    expect(at).toBeLessThanOrEqual(1000 + 165_000)
    expect(registration.expire(at - 1)).toStrictEqual([])
    const refresh = sent(registration.expire(at))
    expect(refresh.cseq.seq).toBe(2)
    expect(refresh.callId).toBe(request.callId)
    expect(refresh.from).toStrictEqual(request.from)
    expect(refresh.via[0]?.params.get("branch")).not.toBe(request.via[0]?.params.get("branch"))
    expect(getHeader(refresh, "Expires")).toBe("600")
  })

  it.each([
    [401, "WWW-Authenticate", "Authorization"],
    [407, "Proxy-Authenticate", "Proxy-Authorization"],
  ])("answers a %d with %s credentials on a new CSeq", (status, challengeName, answerName) => {
    const registration = setup(account)
    const request = sent(registration.register(intent))
    const retry = sent(
      registration.receive(reply(request, status, [challenge("n1", challengeName)]), 10),
    )
    expect(retry.cseq.seq).toBe(2)
    expect(getHeader(retry, answerName)).toMatch(
      /^Digest username="alice", realm="example.com", nonce="n1"/,
    )
    expect(events(registration.receive(reply(retry, 200), 20))).toMatchObject([
      { state: "registered", expires: 3600 },
    ])
  })

  it("does not send credentials again after a successful registration", () => {
    const registration = setup(account)
    const retry = sent(
      registration.receive(reply(sent(registration.register(intent)), 401, [challenge()]), 0),
    )
    registration.receive(reply(retry, 200), 0)
    expect(
      getHeader(sent(registration.expire(Number.MAX_SAFE_INTEGER)), "Authorization"),
    ).toBeUndefined()
  })

  it("trusts the realm and algorithm it registered with, and nothing when no one asked", () => {
    const trust = createTrust()
    const registration = setup(account, 1, trust)
    const retry = sent(
      registration.receive(reply(sent(registration.register(intent)), 401, [challenge()]), 0),
    )
    expect(trust.floors.size).toBe(0)
    registration.receive(reply(retry, 200), 0)
    expect([...trust.floors]).toStrictEqual([["example.com", 3]])
    const open = createTrust()
    const plain = setup(account, 1, open)
    plain.receive(reply(sent(plain.register(intent)), 200), 0)
    expect(open.floors.size).toBe(0)
  })

  it("does not carry spent credentials into a retry after a server error", () => {
    const registration = setup(account)
    const retry = sent(
      registration.receive(reply(sent(registration.register(intent)), 401, [challenge()]), 0),
    )
    registration.receive(reply(retry, 503), 0)
    const again = sent(registration.expire(Number.MAX_SAFE_INTEGER))
    expect(getHeader(again, "Authorization")).toBeUndefined()
    const next = sent(registration.receive(reply(again, 401, [challenge("n2")]), 0))
    expect(getHeader(next, "Authorization")).toContain('nonce="n2"')
  })

  it.each([
    ["wrong credentials", account, [401, 401], { reason: "unauthorized", status: 401 }],
    ["wrong proxy credentials", account, [407, 407], { reason: "unauthorized", status: 407 }],
    ["no credentials", undefined, [401], { reason: "no-credentials" }],
    ["a redirect", account, [302], { reason: "rejected", status: 302, phrase: "Reason" }],
    ["a rejection", account, [404], { reason: "rejected", status: 404, phrase: "Reason" }],
    ["a global failure", account, [604], { reason: "rejected", status: 604, phrase: "Reason" }],
  ] as const)("stops on %s", (_, credentials, statuses, failure) => {
    const registration = setup(credentials)
    let outputs = registration.register(intent)
    for (const status of statuses) {
      const name = status === 407 ? "Proxy-Authenticate" : "WWW-Authenticate"
      outputs = registration.receive(reply(sent(outputs), status, [challenge("n", name)]), 0)
    }
    expect(events(outputs)).toStrictEqual([{ type: "registration", state: "failed", failure }])
    expect(registration.nextDeadline()).toBeUndefined()
  })

  it("retries once with Min-Expires after 423 and refreshes with the original expiry", () => {
    const registration = setup(account)
    const request = sent(registration.register({ ...intent, expires: 60 }))
    const retry = sent(
      registration.receive(reply(request, 423, [{ name: "Min-Expires", value: "120" }]), 0),
    )
    expect(getHeader(retry, "Expires")).toBe("120")
    const again = registration.receive(
      reply(retry, 423, [{ name: "Min-Expires", value: "240" }]),
      0,
    )
    expect(events(again)).toMatchObject([{ state: "failed", failure: { status: 423 } }])
  })

  it.each(["60", "1e3", "Infinity", ""])("gives up on a 423 with Min-Expires %j", (value) => {
    const registration = setup(account)
    const request = sent(registration.register({ ...intent, expires: 60 }))
    const outputs = registration.receive(reply(request, 423, [{ name: "Min-Expires", value }]), 0)
    expect(events(outputs)).toMatchObject([{ state: "failed", failure: { status: 423 } }])
    expect(registration.nextDeadline()).toBeUndefined()
  })

  it("waits as long as Retry-After asks but never less than the backoff", () => {
    const registration = setup(account)
    const outputs = registration.receive(
      reply(sent(registration.register(intent)), 503, [{ name: "Retry-After", value: "120" }]),
      5000,
    )
    expect(events(outputs)).toStrictEqual([
      {
        type: "registration",
        state: "failed",
        failure: { reason: "rejected", status: 503, phrase: "Reason" },
        retryIn: 120_000,
      },
    ])
    expect(registration.nextDeadline()).toBe(125_000)
    const quick = registration.receive(
      reply(sent(registration.expire(125_000)), 503, [{ name: "Retry-After", value: "0" }]),
      125_000,
    )
    expect(events(quick)).toMatchObject([
      { retryIn: expect.toSatisfy((ms: number) => ms >= 60_000) },
    ])
  })

  it("backs off by the RFC 5626 formula and starts over after success or a new register", () => {
    const registration = setup(account)
    let request = sent(registration.register(intent))
    const delays: number[] = []
    for (let round = 1; round <= 3; round++) {
      const [failed] = events(registration.receive({ type: "timeout", request }, 0))
      if (failed?.state === "failed" && failed.retryIn !== undefined) delays.push(failed.retryIn)
      request = sent(registration.expire(Number.MAX_SAFE_INTEGER))
    }
    expect(delays.map((delay, index) => delay / (30_000 * 2 ** index))).toSatisfy(
      (ratios: number[]) => ratios.every((ratio) => ratio >= 1 && ratio <= 2),
    )
    expect(registration.register(intent)).toStrictEqual([])
    const restarted = sent(registration.receive({ type: "timeout", request }, 0))
    const [failed] = events(registration.receive({ type: "timeout", request: restarted }, 0))
    expect(failed?.state === "failed" && failed.retryIn).toSatisfy(
      (ms: number) => ms >= 30_000 && ms <= 60_000,
    )
  })

  it("never overlaps REGISTERs and sends the latest command when the current one ends (RFC 3261 §10.2)", () => {
    const registration = setup(account)
    const first = sent(registration.register(intent))
    expect(registration.register({ ...intent, expires: 60 })).toStrictEqual([])
    expect(registration.unregister()).toStrictEqual([])
    const next = sent(registration.receive(reply(first, 200), 0))
    expect(getHeader(next, "Expires")).toBe("0")
    expect(events(registration.receive(reply(next, 200), 0))).toStrictEqual([
      { type: "registration", state: "unregistered" },
    ])
  })

  it("sends the queued command after a timeout or a challenge as well", () => {
    const registration = setup(account)
    const first = sent(registration.register(intent))
    registration.register({ ...intent, expires: 60 })
    const afterTimeout = sent(registration.receive({ type: "timeout", request: first }, 0))
    expect(getHeader(afterTimeout, "Expires")).toBe("60")
    registration.register({ ...intent, expires: 90 })
    const afterChallenge = sent(registration.receive(reply(afterTimeout, 401, [challenge()]), 0))
    expect(getHeader(afterChallenge, "Expires")).toBe("90")
    expect(getHeader(afterChallenge, "Authorization")).toBeDefined()
  })

  it("starts a queued register without the credentials of the unfinished one", () => {
    const registration = setup(account)
    const retry = sent(
      registration.receive(reply(sent(registration.register(intent)), 401, [challenge()]), 0),
    )
    expect(registration.register(intent)).toStrictEqual([])
    const fresh = sent(registration.receive(reply(retry, 200), 0))
    expect(getHeader(fresh, "Authorization")).toBeUndefined()
  })

  it("ignores provisional responses and responses to other transactions", () => {
    const registration = setup(account)
    const current = sent(registration.register(intent))
    const other = sent(setup(account, 2).register(intent))
    expect(registration.receive(reply(current, 100), 0)).toStrictEqual([])
    expect(registration.receive(reply(other, 200), 0)).toStrictEqual([])
    expect(registration.receive({ type: "timeout", request: other }, 0)).toStrictEqual([])
    expect(events(registration.receive(reply(current, 200), 0))).toMatchObject([
      { state: "registered" },
    ])
  })

  it("treats a 2xx that drops our binding as not bound", () => {
    const registration = setup(account)
    const request = sent(registration.register(intent))
    const outputs = registration.receive(
      reply(request, 200, [{ name: "Expires", value: "0" }], "OK"),
      0,
    )
    expect(events(outputs)).toStrictEqual([
      { type: "registration", state: "failed", failure: { reason: "not-bound" } },
    ])
  })

  it("unregisters with Expires 0 and stops refreshing", () => {
    const registration = setup(account)
    registration.receive(reply(sent(registration.register(intent)), 200), 0)
    const request = sent(registration.unregister())
    expect(getHeader(request, "Expires")).toBe("0")
    expect(events(registration.receive(reply(request, 200), 0))).toStrictEqual([
      { type: "registration", state: "unregistered" },
    ])
    expect(registration.nextDeadline()).toBeUndefined()
    expect(registration.expire(Number.MAX_SAFE_INTEGER)).toStrictEqual([])
    expect(registration.unregister()).toStrictEqual([])
  })

  it("unregisters at the registrar of the latest register", () => {
    const registration = setup(account)
    const first = sent(registration.register(intent))
    registration.register({ ...intent, registrar: "sip:other.example.com" })
    registration.unregister()
    expect(sent(registration.receive(reply(first, 200), 0)).uri).toBe("sip:other.example.com")
  })

  it("can still unregister after a refresh failed for good", () => {
    const registration = setup(account)
    registration.receive(reply(sent(registration.register(intent)), 200), 0)
    registration.receive(reply(sent(registration.expire(Number.MAX_SAFE_INTEGER)), 403), 0)
    expect(getHeader(sent(registration.unregister()), "Expires")).toBe("0")
  })

  it("unregisters the target of a scheduled retry", () => {
    const registration = setup(account)
    registration.receive(reply(sent(registration.register(intent)), 503), 0)
    expect(getHeader(sent(registration.unregister()), "Expires")).toBe("0")
  })

  it("never turns an unregister into a register on 423", () => {
    const registration = setup(account)
    registration.receive(reply(sent(registration.register(intent)), 200), 0)
    const request = sent(registration.unregister())
    const outputs = registration.receive(
      reply(request, 423, [{ name: "Min-Expires", value: "60" }]),
      0,
    )
    expect(events(outputs)).toMatchObject([{ state: "failed", failure: { status: 423 } }])
    expect(registration.nextDeadline()).toBeUndefined()
  })

  it("authenticates an unregister and forgets the binding when it fails", () => {
    const registration = setup(account)
    registration.receive(reply(sent(registration.register(intent)), 200), 0)
    const retry = sent(
      registration.receive(reply(sent(registration.unregister()), 401, [challenge()]), 0),
    )
    expect(getHeader(retry, "Authorization")).toBeDefined()
    expect(events(registration.receive(reply(retry, 500), 0))).toMatchObject([{ state: "failed" }])
    expect(registration.nextDeadline()).toBeUndefined()
    expect(registration.unregister()).toStrictEqual([])
  })

  it("does nothing before the first register", () => {
    const registration = setup(account)
    expect(
      registration.receive(reply(sent(setup(account).register(intent)), 200), 0),
    ).toStrictEqual([])
    expect(registration.expire(0)).toStrictEqual([])
    expect(registration.unregister()).toStrictEqual([])
    expect(registration.nextDeadline()).toBeUndefined()
  })
})
