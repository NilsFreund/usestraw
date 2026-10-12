import { describe, expect, it } from "vitest"
import {
  type Core,
  type CoreInput,
  type CoreOutput,
  createCore,
  createResponse,
  isRequest,
  type SipMessage,
  type SipRequest,
  serializeMessage,
  type TransportAddress,
} from "../../src/core"
import { createRandom } from "../../src/simulation/random"
import { alice, bob, bytes, fixture, parsed } from "../helpers"

function core(seed = 1): Core {
  return createCore({ address: alice, aor: "sip:alice@example.com", random: createRandom(seed) })
}

function busy(): Core {
  return createCore({
    address: alice,
    aor: "sip:alice@example.com",
    random: createRandom(1),
    maxCalls: 0,
  })
}

function sent(outputs: CoreOutput[]) {
  return outputs.flatMap((output) => (output.type === "send" ? [output] : []))
}

function events(outputs: CoreOutput[]) {
  return outputs.flatMap((output) => (output.type === "event" ? [output.event] : []))
}

function message(output: CoreOutput | undefined): SipMessage {
  if (output?.type !== "send") throw new Error("Expected a send output")
  return parsed(output.data)
}

function sentRequest(output: CoreOutput | undefined): SipRequest {
  const request = message(output)
  if (!isRequest(request)) throw new Error("Expected a request")
  return request
}

function statuses(outputs: CoreOutput[]): number[] {
  return sent(outputs).map((output) => {
    const response = message(output)
    return "status" in response ? response.status : 0
  })
}

const options = (uri = "sip:bob@example.com", callId?: string) =>
  ({
    type: "command",
    command: { type: "options", uri, to: bob, ...(callId === undefined ? {} : { callId }) },
  }) as const

const receive = (data: Uint8Array, from = bob) => ({ type: "receive", data, from }) as const

function incoming(
  method: string,
  via = "Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bK1",
  to = "To: <sip:alice@example.com>",
) {
  return bytes(
    [
      `${method} sip:alice@example.com SIP/2.0`,
      via,
      "From: <sip:bob@example.com>;tag=b1",
      to,
      "Call-ID: ping-1",
      `CSeq: 7 ${method}`,
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n"),
  )
}

function ackFor(rejection: SipMessage, via?: string): Uint8Array {
  return incoming("ACK", via, `To: <sip:alice@example.com>;tag=${rejection.to.params.get("tag")}`)
}

function responseTo(request: SipRequest, status = 200): Uint8Array {
  return serializeMessage(createResponse(request, status, "Reason", { toTag: "b1" }))
}

function drain(
  ua: Core,
  until = Number.POSITIVE_INFINITY,
): { at: number; outputs: CoreOutput[] }[] {
  const log: { at: number; outputs: CoreOutput[] }[] = []
  for (let at = ua.nextDeadline(); at !== undefined && at <= until; at = ua.nextDeadline()) {
    if (log.length === 1000) throw new Error("The core keeps firing")
    log.push({ at, outputs: ua.handle({ type: "timeout" }, at) })
  }
  return log
}

describe("createCore", () => {
  describe("outgoing OPTIONS", () => {
    it("sends a well-formed request through a client transaction", () => {
      const ua = core()
      const [output] = ua.handle(options(), 1000)
      expect(output).toMatchObject({ type: "send", to: bob })
      const request = sentRequest(output)
      expect(request).toMatchObject({
        method: "OPTIONS",
        uri: "sip:bob@example.com",
        maxForwards: 70,
        from: { uri: "sip:alice@example.com" },
        to: { uri: "sip:bob@example.com" },
        cseq: { seq: 1, method: "OPTIONS" },
        via: [{ transport: "UDP", host: "192.0.2.10", port: 5060 }],
      })
      expect(request.via[0]?.params.get("branch")).toMatch(/^z9hG4bK[a-z0-9]{16}$/)
      expect(request.via[0]?.params.get("rport")).toBeNull()
      expect(request.from.params.get("tag")).toMatch(/^[a-z0-9]{10}$/)
      expect(request.callId).toMatch(/^[a-z0-9]{20}$/)
      expect(ua.nextDeadline()).toBe(1500)
    })

    it("sends OPTIONS with the Call-ID it was given", () => {
      const request = sentRequest(core().handle(options("sip:bob@example.com", "ping-7"), 0)[0])
      expect(request.callId).toBe("ping-7")
    })

    it("retransmits the same request until it times out at Timer F", () => {
      const ua = core()
      const [first] = ua.handle(options(), 0)
      const log = drain(ua)
      const retransmissions = log.flatMap(({ at, outputs }) => sent(outputs).map(() => at))
      expect(retransmissions).toEqual([
        500, 1500, 3500, 7500, 11500, 15500, 19500, 23500, 27500, 31500,
      ])
      expect(sent(log[0]?.outputs ?? [])[0]).toEqual(first)
      expect(log.at(-1)).toMatchObject({
        at: 32_000,
        outputs: [{ type: "event", event: { type: "timeout", request: { method: "OPTIONS" } } }],
      })
    })

    it("reports the final response, stops retransmitting and absorbs repeats", () => {
      const ua = core()
      const request = sentRequest(ua.handle(options(), 0)[0])
      expect(events(ua.handle(receive(responseTo(request)), 40))).toMatchObject([
        { type: "response", response: { status: 200 }, from: bob },
      ])
      expect(ua.handle(receive(responseTo(request)), 60)).toEqual([])
      expect(ua.nextDeadline()).toBe(5040)
      expect(drain(ua).flatMap(({ outputs }) => outputs)).toEqual([])
    })

    it("reports provisional responses and keeps waiting", () => {
      const ua = core()
      const request = sentRequest(ua.handle(options(), 0)[0])
      expect(events(ua.handle(receive(responseTo(request, 100)), 40))).toMatchObject([
        { type: "response", response: { status: 100 } },
      ])
      expect(ua.nextDeadline()).toBe(500)
    })
  })

  describe("response filtering (RFC 3261 §18.1.2 and §17.1.3)", () => {
    const cases: [string, (request: SipRequest) => SipMessage][] = [
      ["an unknown branch", (request) => withTopVia(request, { branch: "z9hG4bKunknown" })],
      ["a missing branch", (request) => withTopVia(request, { branch: undefined })],
      ["a CSeq method mismatch", (request) => ({ ...request, cseq: { seq: 1, method: "INVITE" } })],
      ["a foreign sent-by host", (request) => withTopVia(request, { host: "198.51.100.1" })],
      ["a foreign sent-by port", (request) => withTopVia(request, { port: 5070 })],
      ["more than one Via", (request) => ({ ...request, via: [...request.via, ...request.via] })],
      ["a foreign transport", (request) => withTopVia(request, { transport: "TCP" })],
    ]

    it.each(cases)("reports a response with %s as stray", (_, change) => {
      const ua = core()
      const request = sentRequest(ua.handle(options(), 0)[0])
      const changed = change(request)
      if (!isRequest(changed)) throw new Error("Expected a request")
      expect(ua.handle(receive(responseTo(changed)), 10)).toMatchObject([
        { type: "event", event: { type: "stray", response: { status: 200 }, from: bob } },
      ])
      expect(ua.nextDeadline()).toBe(500)
    })

    it("accepts a sent-by host echoed in different case", () => {
      const ua = core()
      const request = sentRequest(ua.handle(options(), 0)[0])
      const echoed = withTopVia(request, { host: alice.host.toUpperCase() })
      expect(events(ua.handle(receive(responseTo(echoed)), 10))).toMatchObject([
        { type: "response" },
      ])
    })

    it("reports responses to requests sent with the send command as stray", () => {
      const ua = core()
      const request = sentRequest(ua.handle(options(), 0)[0])
      const raw = withTopVia(request, { branch: "z9hG4bKraw" })
      ua.handle({ type: "command", command: { type: "send", message: raw, to: bob } }, 0)
      expect(events(ua.handle(receive(responseTo(raw)), 10))).toMatchObject([{ type: "stray" }])
    })
  })

  describe("registration", () => {
    const account = { username: "alice", password: "secret" }
    const registering = () =>
      createCore({
        address: alice,
        aor: "sip:alice@example.com",
        random: createRandom(1),
        credentials: account,
      })
    const register = {
      type: "command",
      command: { type: "register", to: bob, expires: 120 },
    } as const

    it("places calls from the public Contact it learnt while registering behind a NAT", () => {
      const ua = registering()
      const request = sentRequest(ua.handle(register, 0)[0])
      const [via, ...rest] = request.via
      if (!via) throw new Error("No Via")
      const seen = new Map([...via.params, ["received", "203.0.113.1"], ["rport", "33172"]])
      const ok = createResponse(
        { ...request, via: [{ ...via, params: seen }, ...rest] },
        200,
        "OK",
        {
          toTag: "r1",
        },
      )
      ua.handle(receive(serializeMessage(ok)), 10)
      const media = { host: "192.0.2.10", port: 40_000 }
      const call = { type: "call", call: "c1", uri: "sip:bob@example.com", to: bob, media } as const
      const invite = sentRequest(ua.handle({ type: "command", command: call }, 20)[0])
      expect(invite.contact).toStrictEqual([
        { uri: "sip:alice@203.0.113.1:33172", params: new Map() },
      ])
    })

    const seenAt = (request: SipRequest, received: string, rport: string) => {
      const [via, ...rest] = request.via
      if (!via) throw new Error("No Via")
      const params = new Map([...via.params, ["received", received], ["rport", rport]])
      const answer = { ...request, via: [{ ...via, params }, ...rest] }
      return serializeMessage(createResponse(answer, 200, "OK", { toTag: "r1" }))
    }
    const contactOf = (ua: Core, at: number) => {
      const media = { host: "192.0.2.10", port: 40_000 }
      const call = {
        type: "call",
        call: `c${at}`,
        uri: "sip:bob@example.com",
        to: bob,
        media,
      } as const
      return sentRequest(ua.handle({ type: "command", command: call }, at)[0]).contact
    }

    it("places calls from the public address an OPTIONS answer showed, when it never registers", () => {
      const ua = registering()
      const ping = sentRequest(ua.handle(options(), 0)[0])
      ua.handle(receive(seenAt(ping, "203.0.113.1", "33172")), 10)
      expect(contactOf(ua, 20)).toStrictEqual([
        { uri: "sip:alice@203.0.113.1:33172", params: new Map() },
      ])
    })

    it("never trades the public address it learnt for a private one", () => {
      const ua = createCore({
        address: { ...alice, host: "10.0.0.5" },
        aor: "sip:alice@example.com",
        random: createRandom(1),
      })
      const first = sentRequest(ua.handle(options(), 0)[0])
      ua.handle(receive(seenAt(first, "203.0.113.1", "33172")), 10)
      const second = sentRequest(ua.handle(options(), 20)[0])
      ua.handle(receive(seenAt(second, "10.0.0.9", "5060")), 30)
      expect(contactOf(ua, 40)).toStrictEqual([
        { uri: "sip:alice@203.0.113.1:33172", params: new Map() },
      ])
    })

    it("leaves the Contact to the registration once it registers", () => {
      const ua = registering()
      sentRequest(ua.handle(register, 0)[0])
      const ping = sentRequest(ua.handle(options(), 1)[0])
      ua.handle(receive(seenAt(ping, "203.0.113.1", "33172")), 10)
      expect(contactOf(ua, 20)).toStrictEqual([
        { uri: "sip:alice@192.0.2.10:5060", params: new Map() },
      ])
    })

    it("follows a reconnect to its new port in Via and Contact, and drops the old binding", () => {
      const tls = { transport: "TLS", host: "192.0.2.10", port: 50_001 } as const
      const ua = createCore({
        address: tls,
        aor: "sip:alice@example.com",
        random: createRandom(1),
        credentials: account,
      })
      ua.handle(receive(responseTo(sentRequest(ua.handle(register, 0)[0]))), 10)
      const move = { type: "move", address: { ...tls, port: 50_002 } } as const
      expect(ua.handle({ type: "command", command: move }, 20)).toStrictEqual([])
      const request = sentRequest(ua.handle(register, 30)[0])
      expect(request.via[0]).toMatchObject({ transport: "TLS", host: "192.0.2.10", port: 50_002 })
      expect(request.contact).toStrictEqual([
        { uri: "sips:alice@192.0.2.10:50002", params: new Map() },
        { uri: "sips:alice@192.0.2.10:50001", params: new Map([["expires", "0"]]) },
      ])
      expect(events(ua.handle(receive(responseTo(request)), 40))).toMatchObject([
        { state: "registered" },
      ])
      expect(contactOf(ua, 50)).toStrictEqual([
        { uri: "sips:alice@192.0.2.10:50002", params: new Map() },
      ])
      const nowhere = { type: "move", address: { ...tls, host: "" } } as const
      expect(() => ua.handle({ type: "command", command: nowhere }, 60)).toThrow(TypeError)
    })

    describe("audio behind a 1:1 NAT", () => {
      const natted = () =>
        createCore({
          address: { transport: "TLS", host: "10.0.0.5", port: 5061 },
          aor: "sip:alice@example.com",
          random: createRandom(1),
        })
      const sdpOf = (ua: Core, at: number, host = "10.0.0.5") => {
        const media = { host, port: 40_000 }
        const call = {
          type: "call",
          call: `s${at}`,
          uri: "sip:bob@example.com",
          to: bob,
          media,
        } as const
        const invite = sentRequest(ua.handle({ type: "command", command: call }, at)[0])
        return new TextDecoder().decode(invite.body)
      }
      const learnt = (received: string, rport = "5061") => {
        const ua = natted()
        const request = sentRequest(ua.handle(register, 0)[0])
        ua.handle(receive(seenAt(request, received, rport)), 10)
        return ua
      }
      const moveTo = (ua: Core, host: string, port: number) => {
        const address = { transport: "TLS", host, port } as const
        ua.handle({ type: "command", command: { type: "move", address } }, 15)
        return ua
      }

      it("offers audio at the public address the server saw, over TLS too", () => {
        const body = sdpOf(learnt("203.0.113.1"), 20)
        expect(body).toMatch(/^o=- \d+ 1 IN IP4 203\.0\.113\.1\r$/m)
        expect(body).toContain("c=IN IP4 203.0.113.1\r\n")
      })

      it("answers at the public address too", () => {
        const ua = learnt("203.0.113.1")
        ua.handle(receive(incoming("INVITE", undefined, "To: <sip:alice@example.com>")), 20)
        const media = { host: "10.0.0.5", port: 40_000 }
        const accept = { type: "accept", call: "ping-1", media } as const
        const [ok] = sent(ua.handle({ type: "command", command: accept }, 30))
        expect(new TextDecoder().decode(message(ok).body)).toContain("c=IN IP4 203.0.113.1\r\n")
      })

      it("learns it from the server's answer to a ping when it never registers", () => {
        const ua = natted()
        const ping = sentRequest(ua.handle(options(), 0)[0])
        ua.handle(receive(seenAt(ping, "203.0.113.1", "5061")), 10)
        expect(sdpOf(ua, 20)).toContain("c=IN IP4 203.0.113.1\r\n")
      })

      it("keeps it through a reconnect on the same network", () => {
        const ua = moveTo(learnt("203.0.113.1"), "10.0.0.5", 50_002)
        expect(sdpOf(ua, 20)).toContain("c=IN IP4 203.0.113.1\r\n")
      })

      it("keeps a public address it learnt over a private one or a name seen later", () => {
        const ua = learnt("203.0.113.1")
        for (const [at, received] of [
          [20, "10.0.0.9"],
          [40, "nat.example.com"],
        ] as const) {
          const ping = sentRequest(ua.handle(options(), at)[0])
          ua.handle(receive(seenAt(ping, received, "5061")), at + 10)
        }
        expect(sdpOf(ua, 60)).toContain("c=IN IP4 203.0.113.1\r\n")
      })

      it.each([
        ["nothing was learnt", natted(), "10.0.0.5"],
        ["the server saw a private address", learnt("10.0.0.9"), "10.0.0.5"],
        ["the NAT changed our port", learnt("203.0.113.1", "33172"), "10.0.0.5"],
        ["the server named no usable address", learnt("0.0.0.0"), "10.0.0.5"],
        ["the server named a host instead of an address", learnt("nat.example.com"), "10.0.0.5"],
        [
          "it moved to another network",
          moveTo(learnt("203.0.113.1"), "10.9.9.5", 5061),
          "10.9.9.5",
        ],
        ["audio already has a public address", learnt("203.0.113.1"), "198.51.100.5"],
        ["audio uses another IP family", learnt("203.0.113.1"), "fd00::5"],
      ])("leaves the audio address alone when %s", (_, ua, host) => {
        expect(sdpOf(ua, 20, host)).toContain(` ${host}\r\n`)
      })
    })

    it("sends a REGISTER through a client transaction and reports the binding", () => {
      const ua = registering()
      const request = sentRequest(ua.handle(register, 0)[0])
      expect(request).toMatchObject({ method: "REGISTER", uri: "sip:example.com" })
      expect(ua.nextDeadline()).toBe(500)
      expect(events(ua.handle(receive(responseTo(request)), 40))).toStrictEqual([
        { type: "registration", state: "registered", expires: 120 },
      ])
      expect(ua.nextDeadline()).toBe(5040)
    })

    it("answers a challenge inside the core and refreshes on its own", () => {
      const ua = registering()
      const request = sentRequest(ua.handle(register, 0)[0])
      const challenge = {
        name: "WWW-Authenticate",
        value: 'Digest realm="example.com", nonce="n", qop="auth"',
      }
      const unauthorized = serializeMessage(
        createResponse(request, 401, "Unauthorized", { toTag: "r", headers: [challenge] }),
      )
      const retry = sentRequest(sent(ua.handle(receive(unauthorized), 40)).at(-1))
      expect(retry.headers.map((header) => header.name)).toContain("Authorization")
      ua.handle(receive(responseTo(retry)), 80)
      const refreshes = drain(ua, 61_000).flatMap(({ at, outputs }) =>
        sent(outputs)
          .filter((output) => message(output).cseq.method === "REGISTER")
          .map(() => at),
      )
      expect(refreshes[0]).toBeGreaterThanOrEqual(80 + 54_000)
      expect(refreshes[0]).toBeLessThanOrEqual(80 + 66_000)
    })

    it("turns a REGISTER timeout into a registration failure with a retry", () => {
      const ua = registering()
      ua.handle(register, 0)
      const failure = drain(ua, 40_000)
        .flatMap(({ outputs }) => events(outputs))
        .find((event) => event.type === "registration")
      expect(failure).toMatchObject({
        state: "failed",
        failure: { reason: "timeout" },
        retryIn: expect.any(Number),
      })
    })

    it("still reports OPTIONS responses and timeouts directly", () => {
      const ua = registering()
      ua.handle(register, 0)
      const request = sentRequest(ua.handle(options(), 0)[0])
      expect(events(ua.handle(receive(responseTo(request)), 10))).toMatchObject([
        { type: "response" },
      ])
    })

    it("unregisters", () => {
      const ua = registering()
      ua.handle(receive(responseTo(sentRequest(ua.handle(register, 0)[0]))), 10)
      const request = sentRequest(
        ua.handle({ type: "command", command: { type: "unregister" } }, 20)[0],
      )
      expect(request.headers).toContainEqual({ name: "Expires", value: "0" })
      expect(events(ua.handle(receive(responseTo(request)), 30))).toStrictEqual([
        { type: "registration", state: "unregistered" },
      ])
    })

    it.each([
      ["an invalid destination", { type: "register", to: { ...bob, port: 0.5 } }, TypeError],
      [
        "a registrar that is no URI",
        { type: "register", to: bob, registrar: "example.com" },
        TypeError,
      ],
      [
        "a registrar with a user part",
        { type: "register", to: bob, registrar: "sip:bob@example.com" },
        TypeError,
      ],
      [
        "a registrar that is not SIP",
        { type: "register", to: bob, registrar: "tel:+4930123" },
        TypeError,
      ],
      ["an invalid expiry", { type: "register", to: bob, expires: 0 }, RangeError],
    ] as const)("rejects %s before changing any state", (_, command, error) => {
      const ua = registering()
      expect(() => ua.handle({ type: "command", command }, 0)).toThrow(error)
      expect(ua.nextDeadline()).toBeUndefined()
    })

    it("needs an explicit registrar for an address of record that is not SIP", () => {
      const ua = createCore({
        address: alice,
        aor: "tel:+4930123",
        random: createRandom(1),
        credentials: account,
      })
      expect(() => ua.handle(register, 0)).toThrow(new TypeError("Invalid registrar undefined"))
      const command = { type: "register", to: bob, registrar: "sip:example.com" } as const
      expect(sentRequest(ua.handle({ type: "command", command }, 0)[0]).uri).toBe("sip:example.com")
    })

    it("keeps the credentials it was created with", () => {
      const credentials = { username: "alice", password: "secret" }
      const ua = createCore({
        address: alice,
        aor: "sip:alice@example.com",
        random: createRandom(1),
        credentials,
      })
      credentials.username = "alice\r\nX: y"
      const request = sentRequest(ua.handle(register, 0)[0])
      const challenge = { name: "WWW-Authenticate", value: 'Digest realm="example.com", nonce="n"' }
      const unauthorized = serializeMessage(
        createResponse(request, 401, "Unauthorized", { toTag: "r", headers: [challenge] }),
      )
      expect(() => ua.handle(receive(unauthorized), 10)).not.toThrow()
    })

    it("accepts an explicit registrar", () => {
      const command = { type: "register", to: bob, registrar: "sip:registrar.example.com" } as const
      expect(sentRequest(registering().handle({ type: "command", command }, 0)[0]).uri).toBe(
        "sip:registrar.example.com",
      )
    })

    it("rejects credentials with line breaks", () => {
      const credentials = { username: "alice\r\nX: y", password: "secret" }
      expect(() =>
        createCore({ address: alice, aor: "sip:a@x", random: createRandom(1), credentials }),
      ).toThrow(TypeError)
    })
  })

  describe("incoming requests", () => {
    it("answers OPTIONS statelessly with 200 OK to the source address", () => {
      const ua = core()
      const outputs = ua.handle(receive(incoming("OPTIONS")), 0)
      expect(outputs.map((output) => output.type)).toEqual(["event", "send"])
      expect(events(outputs)).toMatchObject([
        { type: "answered", request: { method: "OPTIONS" }, from: bob, status: 200 },
      ])
      expect(ua.nextDeadline()).toBeUndefined()
      const [reply] = sent(outputs)
      expect(reply?.to).toEqual(bob)
      const response = message(reply)
      expect(response).toMatchObject({
        status: 200,
        reason: "OK",
        callId: "ping-1",
        cseq: { seq: 7, method: "OPTIONS" },
        headers: [
          { name: "Allow", value: "ACK, BYE, CANCEL, INVITE, OPTIONS" },
          { name: "Accept", value: "application/sdp" },
        ],
      })
      expect(response.to.params.get("tag")).toMatch(/^[a-z0-9]+$/)
    })

    it("answers a retransmitted OPTIONS with the same response and reports it again", () => {
      const ua = core()
      const [reply] = sent(ua.handle(receive(incoming("OPTIONS")), 0))
      const repeat = ua.handle(receive(incoming("OPTIONS")), 500)
      expect(events(repeat)).toMatchObject([{ type: "answered", status: 200 }])
      expect(sent(repeat)).toEqual([reply])
    })

    it.each(["MESSAGE", "NOTIFY"])("rejects %s with 405 and Allow", (method) => {
      const response = message(sent(core().handle(receive(incoming(method)), 0))[0])
      expect(response).toMatchObject({
        status: 405,
        reason: "Method Not Allowed",
        headers: [{ name: "Allow", value: "ACK, BYE, CANCEL, INVITE, OPTIONS" }],
      })
    })

    it("rejects a BYE for an unknown dialog with 481", () => {
      const response = message(sent(core().handle(receive(incoming("BYE")), 0))[0])
      expect(response).toMatchObject({ status: 481, reason: "Call/Transaction Does Not Exist" })
    })

    it("rejects unknown methods with 501", () => {
      const response = message(sent(core().handle(receive(incoming("FOO")), 0))[0])
      expect(response).toMatchObject({ status: 501, reason: "Not Implemented", headers: [] })
    })

    it("rejects INVITE statelessly without retransmissions when busy (RFC 3261 §8.2.7)", () => {
      const ua = busy()
      const outputs = ua.handle(receive(incoming("INVITE")), 0)
      expect(outputs.map((output) => output.type)).toEqual(["event", "send"])
      expect(events(outputs)).toMatchObject([
        { type: "answered", request: { method: "INVITE" }, from: bob, status: 486 },
      ])
      expect(statuses(outputs)).toEqual([486])
      expect(ua.nextDeadline()).toBeUndefined()
    })

    it("reports every copy of a rejected request again", () => {
      const ua = core()
      ua.handle(receive(incoming("MESSAGE")), 0)
      expect(events(ua.handle(receive(incoming("MESSAGE")), 500))).toMatchObject([
        { type: "answered", status: 405 },
      ])
    })

    it("sends a stateless rejection to the sent-by port without rport", () => {
      const via = "Via: SIP/2.0/UDP 192.0.2.20:5070;branch=z9hG4bK1"
      const source = { ...bob, port: 40123 }
      const [reply] = sent(busy().handle(receive(incoming("INVITE", via), source), 0))
      expect(reply?.to).toEqual({ ...bob, port: 5070 })
    })

    it("regenerates the same rejection with the same To tag for a retransmission", () => {
      const ua = busy()
      const [first] = sent(ua.handle(receive(incoming("INVITE")), 0))
      const [again] = sent(ua.handle(receive(incoming("INVITE")), 500))
      expect(again).toEqual(first)
      expect(message(first).to.params.get("tag")).toMatch(/^[a-z0-9]+$/)
    })

    it("gives different requests different stateless tags", () => {
      const ua = busy()
      const via = "Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bK2"
      const tag = (data: Uint8Array) =>
        message(sent(ua.handle(receive(data), 0))[0]).to.params.get("tag")
      expect(tag(incoming("INVITE"))).not.toBe(tag(incoming("INVITE", via)))
    })

    it("swallows the ACK for a stateless rejection", () => {
      const ua = busy()
      const rejection = message(sent(ua.handle(receive(incoming("INVITE")), 0))[0])
      expect(ua.handle(receive(ackFor(rejection)), 100)).toEqual([])
    })

    it("swallows the ACK for a stateless rejection of an RFC 2543 INVITE", () => {
      const ua = busy()
      const via = "Via: SIP/2.0/UDP 192.0.2.20:5060;branch=legacy"
      const rejection = message(sent(ua.handle(receive(incoming("INVITE", via)), 0))[0])
      expect(ua.handle(receive(ackFor(rejection, via)), 100)).toEqual([])
    })

    it("passes an ACK with a foreign To tag to the application", () => {
      const ua = busy()
      ua.handle(receive(incoming("INVITE")), 0)
      const ack = incoming("ACK", undefined, "To: <sip:alice@example.com>;tag=dialog")
      expect(events(ua.handle(receive(ack), 100))).toMatchObject([{ type: "request" }])
    })

    it("cannot recognize the ACK for a rejected request that already had a To tag", () => {
      const ua = core()
      const to = "To: <sip:alice@example.com>;tag=dialog"
      const rejection = message(sent(ua.handle(receive(incoming("INVITE", undefined, to)), 0))[0])
      expect(rejection.to.params.get("tag")).toBe("dialog")
      expect(events(ua.handle(receive(incoming("ACK", undefined, to)), 100))).toMatchObject([
        { type: "request", request: { method: "ACK" } },
      ])
    })

    it("schedules nothing for a flood of distinct requests", () => {
      const ua = busy()
      for (let index = 0; index < 1000; index++) {
        const via = `Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bK${index}`
        ua.handle(receive(incoming(index % 2 === 0 ? "OPTIONS" : "INVITE", via)), 0)
      }
      expect(ua.nextDeadline()).toBeUndefined()
    })

    it("keeps the To tag when a retransmission comes from another port", () => {
      const ua = busy()
      const via = "Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bK1;rport"
      const tag = (port: number) =>
        message(
          sent(ua.handle(receive(incoming("INVITE", via), { ...bob, port }), 0))[0],
        ).to.params.get("tag")
      expect(tag(40_000)).toBe(tag(40_001))
    })

    it("answers OPTIONS with a body with 415 and an empty Accept (RFC 3261 §8.2.3)", () => {
      const data = bytes(
        new TextDecoder()
          .decode(incoming("OPTIONS"))
          .replace(
            "Content-Length: 0\r\n\r\n",
            "Content-Type: application/x-unknown\r\nContent-Length: 3\r\n\r\nv=0",
          ),
      )
      expect(message(sent(core().handle(receive(data), 0))[0])).toMatchObject({
        status: 415,
        headers: [{ name: "Accept", value: "" }],
      })
    })

    it("only lets the accepted hosts start requests, but lets calls finish with anyone", () => {
      const guarded = createCore({
        address: alice,
        aor: "sip:alice@example.com",
        random: createRandom(1),
        acceptFrom: ["192.0.2.20"],
      })
      const stranger = { ...bob, host: "203.0.113.9" }
      expect(guarded.handle(receive(incoming("OPTIONS"), stranger), 0)).toStrictEqual([
        {
          type: "event",
          event: {
            type: "invalid",
            error: "OPTIONS from 203.0.113.9, not an accepted host",
            from: stranger,
          },
        },
      ])
      expect(statuses(guarded.handle(receive(incoming("OPTIONS")), 0))).toStrictEqual([200])
      const forged = incoming("BYE", undefined, "To: <sip:alice@example.com>;tag=gone")
      expect(statuses(guarded.handle(receive(forged, stranger), 0))).toStrictEqual([])
      expect(statuses(guarded.handle(receive(forged), 0))).toStrictEqual([481])
    })

    it("never lets a stranger cancel a ringing call, even with a To tag", () => {
      const guarded = createCore({
        address: alice,
        aor: "sip:alice@example.com",
        random: createRandom(1),
        acceptFrom: ["192.0.2.20"],
      })
      const [ringing] = sent(guarded.handle(receive(incoming("INVITE")), 0))
      const tag = message(ringing).to.params.get("tag")
      const cancel = incoming("CANCEL", undefined, `To: <sip:alice@example.com>;tag=${tag}`)
      const stranger = { ...bob, host: "203.0.113.9" }
      expect(events(guarded.handle(receive(cancel, stranger), 1))).toMatchObject([
        { type: "invalid", error: "CANCEL from 203.0.113.9, not an accepted host" },
      ])
      expect(statuses(guarded.handle(receive(cancel), 2))).toStrictEqual([200, 487])
    })

    it("compares IPv6 sources by value", () => {
      const guarded = createCore({
        address: alice,
        aor: "sip:alice@example.com",
        random: createRandom(1),
        acceptFrom: ["2001:db8::20"],
      })
      const source = { ...bob, host: "2001:DB8:0:0:0:0:0:20" }
      expect(statuses(guarded.handle(receive(incoming("OPTIONS"), source), 0))).toStrictEqual([200])
    })

    it("lets a whole CIDR range start requests, and nobody outside it", () => {
      const guarded = createCore({
        address: alice,
        aor: "sip:alice@example.com",
        random: createRandom(1),
        acceptFrom: ["198.51.100.0/30", "2001:db8::/32"],
      })
      const from = (host: string) =>
        statuses(guarded.handle(receive(incoming("OPTIONS"), { ...bob, host }), 0))
      expect(from("198.51.100.3")).toStrictEqual([200])
      expect(from("2001:db8:ffff::1")).toStrictEqual([200])
      expect(from("198.51.100.4")).toStrictEqual([])
      expect(from("192.0.2.20")).toStrictEqual([])
    })

    it.each([[["example.com"]], [["192.0.2.0/33"]], [[5]], ["192.0.2.20" as unknown as string[]]])(
      "refuses acceptFrom %j",
      (acceptFrom) => {
        expect(() =>
          createCore({
            address: alice,
            aor: "sip:alice@example.com",
            random: Math.random,
            acceptFrom: acceptFrom as string[],
          }),
        ).toThrow(/^acceptFrom must list IP addresses or CIDR ranges, got /)
      },
    )

    it("sends a reply of up to 65535 bytes and only reports a bigger one", () => {
      const named = (length: number) =>
        bytes(
          new TextDecoder()
            .decode(incoming("OPTIONS"))
            .replace("To: <", `To: "${"\t".repeat(length)}" <`),
        )
      const replies = (length: number) => sent(core().handle(receive(named(length)), 0))
      const length = 65_535 - (replies(0)[0]?.data.length ?? 0)
      expect(replies(length)[0]?.data).toHaveLength(65_535)
      const outputs = core().handle(receive(named(length + 1)), 0)
      expect(events(outputs)).toMatchObject([{ type: "answered", status: 200 }])
      expect(sent(outputs)).toHaveLength(0)
    })

    it("answers but sends nothing to a Via that names port 0", () => {
      const data = incoming("OPTIONS", "Via: SIP/2.0/UDP 203.0.113.9:0;branch=z9hG4bKzero")
      const outputs = core().handle(receive(data), 0)
      expect(events(outputs)).toMatchObject([{ type: "answered", status: 200 }])
      expect(sent(outputs)).toHaveLength(0)
    })

    it("refuses to send an app's message above 65535 bytes", () => {
      const message = { ...parsed(incoming("OPTIONS")), body: new Uint8Array(65_535) }
      expect(() =>
        core().handle({ type: "command", command: { type: "send", message, to: bob } }, 0),
      ).toThrow(new RangeError("Message exceeds 65535 bytes"))
    })

    it("passes an ACK without transaction to the application", () => {
      const outputs = core().handle(receive(incoming("ACK")), 0)
      expect(outputs).toMatchObject([{ type: "event", event: { type: "request" } }])
    })

    it("stamps received and rport on the top Via (RFC 3581)", () => {
      const via = "Via: SIP/2.0/UDP 10.0.0.5:5060;branch=z9hG4bK1;rport"
      const response = message(sent(core().handle(receive(incoming("OPTIONS", via)), 0))[0])
      expect(response.via[0]?.params).toEqual(
        new Map([
          ["branch", "z9hG4bK1"],
          ["rport", "5060"],
          ["received", "192.0.2.20"],
        ]),
      )
    })

    it("only stamps the top Via", () => {
      const via = [
        "Via: SIP/2.0/UDP 192.0.2.30:5060;branch=z9hG4bKproxy",
        "Via: SIP/2.0/UDP 10.0.0.5:5060;branch=z9hG4bKorigin",
      ].join("\r\n")
      const response = message(sent(core().handle(receive(incoming("OPTIONS", via)), 0))[0])
      expect(response.via.map((entry) => entry.params.get("received"))).toEqual([
        "192.0.2.20",
        undefined,
      ])
    })

    it("answers RFC 4475 bext01 with 420 listing the unsupported extensions", () => {
      const response = message(sent(core().handle(receive(fixture("bext01")), 0))[0])
      expect(response).toMatchObject({
        status: 420,
        reason: "Bad Extension",
        headers: [{ name: "Unsupported", value: "nothingSupportsThis, nothingSupportsThisEither" }],
      })
    })

    it("answers RFC 4475 unkscm with 416", () => {
      const response = message(sent(core().handle(receive(fixture("unkscm")), 0))[0])
      expect(response).toMatchObject({ status: 416, reason: "Unsupported URI Scheme" })
    })

    it("answers CANCEL without a transaction with 481 statelessly", () => {
      const outputs = core().handle(receive(incoming("CANCEL")), 0)
      expect(events(outputs)).toMatchObject([{ type: "answered", status: 481 }])
      expect(message(sent(outputs)[0])).toMatchObject({ status: 481 })
    })

    it("answers CANCEL for a statelessly rejected INVITE with 481", () => {
      const ua = busy()
      ua.handle(receive(incoming("INVITE")), 0)
      expect(statuses(ua.handle(receive(incoming("CANCEL")), 100))).toEqual([481])
    })

    it("replies to the sent-by port when the client did not ask for rport", () => {
      const via = "Via: SIP/2.0/UDP 192.0.2.20:5070;branch=z9hG4bK1"
      const source = { ...bob, port: 40123 }
      const [reply] = sent(core().handle(receive(incoming("OPTIONS", via), source), 0))
      expect(reply?.to).toEqual({ ...bob, port: 5070 })
    })
  })

  describe("input validation", () => {
    it("rejects unknown inputs and commands from untyped callers", () => {
      const input = { type: "dance" } as unknown as CoreInput
      const command = { type: "command", command: { type: "dance" } } as unknown as CoreInput
      expect(() => core().handle(input, 0)).toThrow(new TypeError('Unknown input {"type":"dance"}'))
      expect(() => core().handle(command, 0)).toThrow(
        new TypeError('Unknown command {"type":"dance"}'),
      )
    })

    const invalidAddresses: TransportAddress[] = [
      { ...alice, host: "evil host" },
      { ...alice, host: "a\r\nb" },
      { ...alice, port: 70_000 },
      { ...alice, port: 1.5 },
      { ...alice, transport: "SCTP" as TransportAddress["transport"] },
    ]

    it.each(invalidAddresses)("rejects the local address %o", (address) => {
      expect(() => createCore({ address, aor: "sip:a@x", random: createRandom(1) })).toThrow(
        TypeError,
      )
    })

    it("requires the source to be an IP address", () => {
      const from = { ...bob, host: "client.example.com" }
      expect(() => core().handle(receive(incoming("OPTIONS"), from), 0)).toThrow(
        'The source must be an IP address, got "client.example.com"',
      )
    })

    it("rejects an invalid source address", () => {
      const from = { ...bob, host: "192.0.2.20\r\nX: y" }
      expect(() => core().handle(receive(incoming("OPTIONS"), from), 0)).toThrow(
        `Invalid address ${JSON.stringify(from)}`,
      )
    })

    const inputs = [
      ["timeout", { type: "timeout" }],
      ["receive", receive(incoming("OPTIONS"))],
      ["command", options()],
    ] as const

    it.each(inputs)("rejects invalid times for %s inputs", (_, input) => {
      for (const now of [Number.NaN, Number.POSITIVE_INFINITY, 1e20, -1e20]) {
        expect(() => core().handle(input, now)).toThrow(new RangeError(`Invalid time ${now}`))
      }
    })

    it("accepts fractional and negative times", () => {
      expect(core().handle({ type: "timeout" }, -1.5)).toEqual([])
    })

    it("refuses to send a message that would inject headers", () => {
      const request = parsed(incoming("OPTIONS"))
      if (!isRequest(request)) throw new Error("Expected a request")
      const response = createResponse(request, 200, "OK\r\nX: y")
      expect(() =>
        core().handle(
          { type: "command", command: { type: "send", message: response, to: bob } },
          0,
        ),
      ).toThrow(TypeError)
    })

    it("rejects an invalid address of record", () => {
      expect(() => createCore({ address: alice, aor: "alice", random: createRandom(1) })).toThrow(
        'Invalid address of record "alice"',
      )
    })

    it("refuses OPTIONS targets that would inject headers", () => {
      expect(() => core().handle(options("sip:b@x SIP/2.0\r\nX-Injected: yes"), 0)).toThrow(
        TypeError,
      )
    })

    it.each([
      ["options", options()],
      [
        "send",
        {
          type: "command",
          command: { type: "send", message: parsed(incoming("OPTIONS")), to: bob },
        },
      ],
    ] as const)("rejects an invalid destination for the %s command", (_, input) => {
      const command = { ...input.command, to: { ...bob, port: 70_000 } }
      expect(() => core().handle({ type: "command", command }, 0)).toThrow("Invalid address")
    })

    it("refuses OPTIONS targets with URI headers", () => {
      expect(() => core().handle(options("sip:b@x?Route=evil"), 0)).toThrow(TypeError)
    })

    it.each([
      "",
      "a b",
      "ping\r\nX-Injected: yes",
      "caf\u00e9",
      "a\u202eb",
      "a@b@c",
      "@b",
      "a@",
      "x".repeat(257),
    ])("refuses the Call-ID %j before starting a transaction", (callId) => {
      const ua = core()
      expect(() => ua.handle(options("sip:bob@example.com", callId), 0)).toThrow("Invalid Call-ID")
      expect(ua.nextDeadline()).toBeUndefined()
    })

    it.each(["a@b", "x".repeat(256), "w-.!%*_+`'~()<>:\\\"/[]?{}@host.example"])(
      "accepts the Call-ID %j",
      (callId) => {
        const request = sentRequest(core().handle(options("sip:bob@example.com", callId), 0)[0])
        expect(request.callId).toBe(callId)
      },
    )
  })

  describe("IPv6", () => {
    it("uses a zoned local address without the zone in Via and matches the response", () => {
      const local = { transport: "UDP", host: "fe80::1%en0", port: 5060 } as const
      const ua = createCore({
        address: local,
        aor: "sip:alice@example.com",
        random: createRandom(1),
      })
      const request = sentRequest(ua.handle(options(), 0)[0])
      expect(request.via[0]?.host).toBe("[fe80::1]")
      expect(events(ua.handle(receive(responseTo(request)), 10))).toMatchObject([
        { type: "response" },
      ])
    })

    it("answers a link-local peer with a zone and leaves the zone out of received", () => {
      const via = "Via: SIP/2.0/UDP [fe80::2]:5060;branch=z9hG4bK1;rport"
      const from = { transport: "UDP", host: "fe80::2%en0", port: 5060 } as const
      const [reply] = sent(core().handle(receive(incoming("OPTIONS", via), from), 0))
      expect(reply?.to).toEqual(from)
      expect(message(reply).via[0]?.params.get("received")).toBe("fe80::2")
    })

    const v6 = { transport: "UDP", host: "2001:db8::10", port: 5060 } as const

    it("brackets the host in Via and matches the response", () => {
      const ua = createCore({ address: v6, aor: "sip:alice@example.com", random: createRandom(1) })
      const request = sentRequest(ua.handle(options(), 0)[0])
      expect(request.via[0]?.host).toBe("[2001:db8::10]")
      expect(events(ua.handle(receive(responseTo(request)), 10))).toMatchObject([
        { type: "response" },
      ])
    })

    it("does not add received when a bracketed sent-by matches the source", () => {
      const via = "Via: SIP/2.0/UDP [2001:db8::20]:5060;branch=z9hG4bK1"
      const from = { transport: "UDP", host: "2001:db8::20", port: 5060 } as const
      const response = message(sent(core().handle(receive(incoming("OPTIONS", via), from), 0))[0])
      expect(response.via[0]?.params.has("received")).toBe(false)
    })
  })

  it("rejects invalid timer settings", () => {
    expect(() =>
      createCore({
        address: alice,
        aor: "sip:alice@example.com",
        random: createRandom(1),
        timers: { t1: 0, t2: 0, t4: 0, d: 0, trying: 0 },
      }),
    ).toThrow("T1 must be positive, got 0")
  })

  it("uses custom timer settings", () => {
    const ua = createCore({
      address: alice,
      aor: "sip:alice@example.com",
      random: createRandom(1),
      timers: { t1: 100, t2: 400, t4: 1000, d: 6400, trying: 40 },
    })
    ua.handle(options(), 0)
    expect(ua.nextDeadline()).toBe(100)
  })

  it("sends messages verbatim on the send command", () => {
    const request = parsed(incoming("MESSAGE"))
    const outputs = core().handle(
      { type: "command", command: { type: "send", message: request, to: bob } },
      0,
    )
    expect(outputs).toEqual([{ type: "send", data: serializeMessage(request), to: bob }])
  })

  it("reports unparseable datagrams", () => {
    expect(core().handle(receive(new Uint8Array([1, 2])), 0)).toEqual([
      {
        type: "event",
        event: { type: "invalid", error: "Missing empty line after headers", from: bob },
      },
    ])
  })

  it("is deterministic for the same random source", () => {
    expect(core(7).handle(options(), 0)).toEqual(core(7).handle(options(), 0))
    expect(core(7).handle(options(), 0)).not.toEqual(core(8).handle(options(), 0))
  })
})

function withTopVia(
  request: SipRequest,
  change: { branch?: string | undefined; host?: string; port?: number; transport?: string },
): SipRequest {
  const [top, ...rest] = request.via
  if (!top) throw new Error("Expected a Via")
  const params = new Map(top.params)
  if ("branch" in change) {
    if (change.branch === undefined) params.delete("branch")
    else params.set("branch", change.branch)
  }
  return {
    ...request,
    via: [
      {
        ...top,
        transport: change.transport ?? top.transport,
        host: change.host ?? top.host,
        port: change.port ?? top.port ?? 5060,
        params,
      },
      ...rest,
    ],
  }
}
