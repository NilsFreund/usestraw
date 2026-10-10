import { describe, expect, it } from "vitest"
import {
  type Address,
  type Core,
  createCore,
  createResponse,
  type Input,
  isRequest,
  type Output,
  type SipMessage,
  type SipRequest,
  serializeMessage,
} from "../../src"
import { createRandom } from "../../src/simulation/random"
import { alice, bob, bytes, fixture, parsed } from "../helpers"

function core(seed = 1): Core {
  return createCore({ address: alice, aor: "sip:alice@example.com", random: createRandom(seed) })
}

function sent(outputs: Output[]) {
  return outputs.flatMap((output) => (output.type === "send" ? [output] : []))
}

function events(outputs: Output[]) {
  return outputs.flatMap((output) => (output.type === "event" ? [output.event] : []))
}

function message(output: Output | undefined): SipMessage {
  if (output?.type !== "send") throw new Error("Expected a send output")
  return parsed(output.data)
}

function sentRequest(output: Output | undefined): SipRequest {
  const request = message(output)
  if (!isRequest(request)) throw new Error("Expected a request")
  return request
}

function statuses(outputs: Output[]): number[] {
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

function drain(ua: Core, until = Number.POSITIVE_INFINITY): { at: number; outputs: Output[] }[] {
  const log: { at: number; outputs: Output[] }[] = []
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
        headers: [{ name: "Allow", value: "ACK, BYE, CANCEL, OPTIONS" }],
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
        headers: [{ name: "Allow", value: "ACK, BYE, CANCEL, OPTIONS" }],
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

    it("rejects INVITE statelessly without retransmissions (RFC 3261 §8.2.7)", () => {
      const ua = core()
      const outputs = ua.handle(receive(incoming("INVITE")), 0)
      expect(outputs.map((output) => output.type)).toEqual(["event", "send"])
      expect(events(outputs)).toMatchObject([
        { type: "answered", request: { method: "INVITE" }, from: bob, status: 405 },
      ])
      expect(statuses(outputs)).toEqual([405])
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
      const [reply] = sent(core().handle(receive(incoming("INVITE", via), source), 0))
      expect(reply?.to).toEqual({ ...bob, port: 5070 })
    })

    it("regenerates the same rejection with the same To tag for a retransmission", () => {
      const ua = core()
      const [first] = sent(ua.handle(receive(incoming("INVITE")), 0))
      const [again] = sent(ua.handle(receive(incoming("INVITE")), 500))
      expect(again).toEqual(first)
      expect(message(first).to.params.get("tag")).toMatch(/^[a-z0-9]+$/)
    })

    it("gives different requests different stateless tags", () => {
      const ua = core()
      const via = "Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bK2"
      const tag = (data: Uint8Array) =>
        message(sent(ua.handle(receive(data), 0))[0]).to.params.get("tag")
      expect(tag(incoming("INVITE"))).not.toBe(tag(incoming("INVITE", via)))
    })

    it("swallows the ACK for a stateless rejection", () => {
      const ua = core()
      const rejection = message(sent(ua.handle(receive(incoming("INVITE")), 0))[0])
      expect(ua.handle(receive(ackFor(rejection)), 100)).toEqual([])
    })

    it("swallows the ACK for a stateless rejection of an RFC 2543 INVITE", () => {
      const ua = core()
      const via = "Via: SIP/2.0/UDP 192.0.2.20:5060;branch=legacy"
      const rejection = message(sent(ua.handle(receive(incoming("INVITE", via)), 0))[0])
      expect(ua.handle(receive(ackFor(rejection, via)), 100)).toEqual([])
    })

    it("passes an ACK with a foreign To tag to the application", () => {
      const ua = core()
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
      const ua = core()
      for (let index = 0; index < 1000; index++) {
        const via = `Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bK${index}`
        ua.handle(receive(incoming(index % 2 === 0 ? "OPTIONS" : "INVITE", via)), 0)
      }
      expect(ua.nextDeadline()).toBeUndefined()
    })

    it("keeps the To tag when a retransmission comes from another port", () => {
      const ua = core()
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

    it("answers but sends nothing when the reply would exceed 65535 bytes", () => {
      const named = (name: string) =>
        new TextDecoder()
          .decode(incoming("OPTIONS"))
          .replace("From: <", `From: "${name}" <`)
          .replace("To: <", `To: "${name}" <`)
      const data = bytes(named("\t".repeat(Math.floor((65_530 - named("").length) / 2))))
      expect(data.length).toBeGreaterThan(65_500)
      const outputs = core().handle(receive(data), 0)
      expect(events(outputs)).toMatchObject([{ type: "answered", status: 200 }])
      expect(sent(outputs)).toEqual([])
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

    it("answers CANCEL without a transaction with 481", () => {
      const response = message(sent(core().handle(receive(incoming("CANCEL")), 0))[0])
      expect(response).toMatchObject({ status: 481 })
    })

    it("answers CANCEL for a statelessly rejected INVITE with 481", () => {
      const ua = core()
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
      const input = { type: "dance" } as unknown as Input
      const command = { type: "command", command: { type: "dance" } } as unknown as Input
      expect(() => core().handle(input, 0)).toThrow(new TypeError('Unknown input {"type":"dance"}'))
      expect(() => core().handle(command, 0)).toThrow(
        new TypeError('Unknown command {"type":"dance"}'),
      )
    })

    const invalidAddresses: Address[] = [
      { ...alice, host: "evil host" },
      { ...alice, host: "a\r\nb" },
      { ...alice, port: 70_000 },
      { ...alice, port: 1.5 },
      { ...alice, transport: "SCTP" as Address["transport"] },
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
