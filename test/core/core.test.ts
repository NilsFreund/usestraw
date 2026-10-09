import { describe, expect, it } from "vitest"
import {
  type Core,
  createCore,
  createResponse,
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

const options = (uri = "sip:bob@example.com") =>
  ({ type: "command", command: { type: "options", uri, to: bob } }) as const

const receive = (data: Uint8Array, from = bob) => ({ type: "receive", data, from }) as const

function incoming(method: string, via = "Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bK1") {
  return bytes(
    [
      `${method} sip:alice@example.com SIP/2.0`,
      via,
      "From: <sip:bob@example.com>;tag=b1",
      "To: <sip:alice@example.com>",
      "Call-ID: ping-1",
      `CSeq: 7 ${method}`,
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n"),
  )
}

function responseTo(request: SipRequest, status = 200): Uint8Array {
  return serializeMessage(createResponse(request, status, "Reason", { toTag: "b1" }))
}

function drain(ua: Core): { at: number; outputs: Output[] }[] {
  const log: { at: number; outputs: Output[] }[] = []
  for (let at = ua.nextDeadline(); at !== undefined; at = ua.nextDeadline()) {
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

  describe("incoming requests", () => {
    it("answers OPTIONS with 200 OK to the source address", () => {
      const outputs = core().handle(receive(incoming("OPTIONS")), 0)
      expect(events(outputs)).toMatchObject([{ type: "request", from: bob }])
      const [reply] = sent(outputs)
      expect(reply?.to).toEqual(bob)
      const response = message(reply)
      expect(response).toMatchObject({
        status: 200,
        reason: "OK",
        callId: "ping-1",
        cseq: { seq: 7, method: "OPTIONS" },
        headers: [{ name: "Allow", value: "OPTIONS" }],
      })
      expect(response.to.params.get("tag")).toMatch(/^[a-z0-9]{10}$/)
    })

    it("absorbs retransmitted requests and resends the same response", () => {
      const ua = core()
      const [reply] = sent(ua.handle(receive(incoming("OPTIONS")), 0))
      const repeat = ua.handle(receive(incoming("OPTIONS")), 500)
      expect(events(repeat)).toEqual([])
      expect(sent(repeat)).toEqual([reply])
    })

    it.each(["MESSAGE", "NOTIFY", "BYE"])("rejects %s with 405 and Allow", (method) => {
      const response = message(sent(core().handle(receive(incoming(method)), 0))[0])
      expect(response).toMatchObject({
        status: 405,
        reason: "Method Not Allowed",
        headers: [{ name: "Allow", value: "OPTIONS" }],
      })
    })

    it("answers INVITE with 405 right away and repeats it until the ACK arrives", () => {
      const ua = core()
      expect(statuses(ua.handle(receive(incoming("INVITE")), 0))).toEqual([405])
      expect(statuses(ua.handle({ type: "timeout" }, 500))).toEqual([405])
      expect(ua.handle(receive(incoming("ACK")), 600)).toEqual([])
      expect(drain(ua).flatMap(({ outputs }) => outputs)).toEqual([])
    })

    it("reports an INVITE rejection that is never acknowledged", () => {
      const ua = core()
      ua.handle(receive(incoming("INVITE")), 0)
      expect(drain(ua).at(-1)).toMatchObject({
        at: 32_000,
        outputs: [{ type: "event", event: { type: "unacknowledged", response: { status: 405 } } }],
      })
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

    it("answers CANCEL for a known INVITE with 200 and leaves the INVITE alone", () => {
      const ua = core()
      ua.handle(receive(incoming("INVITE")), 0)
      const cancel = incoming("CANCEL").slice()
      expect(statuses(ua.handle(receive(cancel), 100))).toEqual([200])
      expect(statuses(ua.handle({ type: "timeout" }, 500))).toEqual([405])
    })

    it("answers CANCEL without a transaction with 481", () => {
      const response = message(sent(core().handle(receive(incoming("CANCEL")), 0))[0])
      expect(response).toMatchObject({ status: 481 })
    })

    it("replies to the sent-by port when the client did not ask for rport", () => {
      const via = "Via: SIP/2.0/UDP 192.0.2.20:5070;branch=z9hG4bK1"
      const source = { ...bob, port: 40123 }
      const [reply] = sent(core().handle(receive(incoming("OPTIONS", via), source), 0))
      expect(reply?.to).toEqual({ ...bob, port: 5070 })
    })
  })

  describe("input validation", () => {
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

    it("refuses OPTIONS targets with URI headers", () => {
      expect(() => core().handle(options("sip:b@x?Route=evil"), 0)).toThrow(TypeError)
    })
  })

  describe("IPv6", () => {
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
