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

function message(output: Output | undefined): SipMessage {
  if (output?.type !== "send") throw new Error("Expected a send output")
  return parsed(output.data)
}

function sentRequest(output: Output | undefined): SipRequest {
  const request = message(output)
  if (!isRequest(request)) throw new Error("Expected a request")
  return request
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

describe("createCore", () => {
  describe("outgoing OPTIONS", () => {
    it("sends a well-formed request and waits until Timer F", () => {
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
      expect(ua.nextDeadline()).toBe(33_000)
    })

    it("reports the matching final response and stops waiting", () => {
      const ua = core()
      const request = sentRequest(ua.handle(options(), 0)[0])
      expect(ua.handle(receive(responseTo(request)), 40)).toMatchObject([
        { type: "event", event: { type: "response", response: { status: 200 }, from: bob } },
      ])
      expect(ua.nextDeadline()).toBeUndefined()
    })

    it("keeps waiting after a provisional response", () => {
      const ua = core()
      const request = sentRequest(ua.handle(options(), 0)[0])
      expect(ua.handle(receive(responseTo(request, 100)), 40)).toHaveLength(1)
      expect(ua.nextDeadline()).toBe(32_000)
    })

    it("tracks several requests with their own deadlines", () => {
      const ua = core()
      ua.handle(options(), 0)
      ua.handle(options(), 1000)
      expect(ua.nextDeadline()).toBe(32_000)
      expect(ua.handle({ type: "timeout" }, 32_000)).toHaveLength(1)
      expect(ua.nextDeadline()).toBe(33_000)
    })

    it("times out when no response arrives", () => {
      const ua = core()
      ua.handle(options(), 0)
      expect(ua.handle({ type: "timeout" }, 31_999)).toEqual([])
      expect(ua.handle({ type: "timeout" }, 32_000)).toMatchObject([
        { type: "event", event: { type: "timeout", request: { method: "OPTIONS" } } },
      ])
      expect(ua.nextDeadline()).toBeUndefined()
    })
  })

  describe("response matching (RFC 3261 §17.1.3 and §18.1.2)", () => {
    const cases: [string, (request: SipRequest) => SipMessage][] = [
      ["an unknown branch", (request) => withTopVia(request, { branch: "z9hG4bKunknown" })],
      ["a missing branch", (request) => withTopVia(request, { branch: undefined })],
      ["a CSeq method mismatch", (request) => ({ ...request, cseq: { seq: 1, method: "INVITE" } })],
      ["a foreign sent-by host", (request) => withTopVia(request, { host: "198.51.100.1" })],
      ["a foreign sent-by port", (request) => withTopVia(request, { port: 5070 })],
      ["more than one Via", (request) => ({ ...request, via: [...request.via, ...request.via] })],
      ["a foreign transport", (request) => withTopVia(request, { transport: "TCP" })],
    ]

    it.each(cases)("reports a response with %s as stray and keeps waiting", (_, change) => {
      const ua = core()
      const request = sentRequest(ua.handle(options(), 0)[0])
      const changed = change(request)
      if (!isRequest(changed)) throw new Error("Expected a request")
      expect(ua.handle(receive(responseTo(changed)), 10)).toMatchObject([
        { type: "event", event: { type: "stray", response: { status: 200 }, from: bob } },
      ])
      expect(ua.nextDeadline()).toBe(32_000)
    })

    it("accepts a sent-by host echoed in different case", () => {
      const ua = core()
      const request = sentRequest(ua.handle(options(), 0)[0])
      const echoed = withTopVia(request, { host: alice.host.toUpperCase() })
      expect(ua.handle(receive(responseTo(echoed)), 10)).toMatchObject([
        { type: "event", event: { type: "response" } },
      ])
    })

    it("reports responses to requests sent with the send command as stray", () => {
      const ua = core()
      const request = sentRequest(ua.handle(options(), 0)[0])
      const raw = withTopVia(request, { branch: "z9hG4bKraw" })
      ua.handle({ type: "command", command: { type: "send", message: raw, to: bob } }, 0)
      expect(ua.handle(receive(responseTo(raw)), 10)).toMatchObject([
        { type: "event", event: { type: "stray" } },
      ])
    })
  })

  describe("incoming requests", () => {
    it("answers OPTIONS with 200 OK to the source address", () => {
      const outputs = core().handle(receive(incoming("OPTIONS")), 0)
      expect(outputs[0]).toMatchObject({ type: "event", event: { type: "request", from: bob } })
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

    it.each(["INVITE", "MESSAGE", "NOTIFY", "BYE"])("rejects %s with 405 and Allow", (method) => {
      const response = message(sent(core().handle(receive(incoming(method)), 0))[0])
      expect(response).toMatchObject({
        status: 405,
        reason: "Method Not Allowed",
        headers: [{ name: "Allow", value: "OPTIONS" }],
      })
    })

    it("never answers ACK", () => {
      const outputs = core().handle(receive(incoming("ACK")), 0)
      expect(outputs).toMatchObject([{ type: "event", event: { type: "request" } }])
    })

    it("stamps received and rport on the top Via (RFC 3581)", () => {
      const via = "Via: SIP/2.0/UDP 10.0.0.5:5060;branch=z9hG4bK1;rport"
      const outputs = core().handle(receive(incoming("OPTIONS", via)), 0)
      const response = message(sent(outputs)[0])
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

    it("replies to the sent-by port when the client did not ask for rport", () => {
      const via = "Via: SIP/2.0/UDP 192.0.2.20:5070;branch=z9hG4bK1"
      const source = { ...bob, port: 40123 }
      const [reply] = sent(core().handle(receive(incoming("OPTIONS", via), source), 0))
      expect(reply?.to).toEqual({ ...bob, port: 5070 })
    })

    it.todo("absorbs retransmitted requests with the same response (milestone 4)")
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
      expect(ua.handle(receive(responseTo(request)), 10)).toHaveLength(1)
    })

    it("does not add received when a bracketed sent-by matches the source", () => {
      const via = "Via: SIP/2.0/UDP [2001:db8::20]:5060;branch=z9hG4bK1"
      const from = { transport: "UDP", host: "2001:db8::20", port: 5060 } as const
      const response = message(sent(core().handle(receive(incoming("OPTIONS", via), from), 0))[0])
      expect(response.via[0]?.params.has("received")).toBe(false)
    })
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
