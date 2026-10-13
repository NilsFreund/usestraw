import { describe, expect, it } from "vitest"
import {
  type CoreCommand,
  type CoreOutput,
  createCore,
  createResponse,
  getHeader,
  isRequest,
  parseMessage,
  type SipMessage,
  type SipRequest,
  type SipResponse,
  serializeMessage,
} from "../../src/core"
import { createRandom } from "../../src/simulation/random"
import { alice, aliceMedia, bob, bytes } from "../helpers"
import { events } from "./support"

// What a browser and FreeSWITCH put in WebRTC calls, shortened
const offer = (version = 1) =>
  [
    "v=0",
    `o=FreeSWITCH 1760000000 ${version} IN IP4 192.0.2.20`,
    "s=FreeSWITCH",
    "t=0 0",
    "m=audio 24436 UDP/TLS/RTP/SAVPF 0 101",
    "c=IN IP4 192.0.2.20",
    "a=rtpmap:0 PCMU/8000",
    "a=rtpmap:101 telephone-event/8000",
    "a=setup:actpass",
    "a=fingerprint:sha-256 AA:BB:CC:DD",
    "a=ice-ufrag:far1",
    "a=ice-pwd:farfarfarfarfarfarfarfar",
    "a=candidate:1 1 UDP 2130706431 192.0.2.20 24436 typ host",
    "a=rtcp-mux",
    "",
  ].join("\r\n")
const answer = (session = 1) =>
  [
    "v=0",
    `o=- 4611731400430051336 ${session} IN IP4 127.0.0.1`,
    "s=-",
    "t=0 0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 0",
    "c=IN IP4 0.0.0.0",
    "a=setup:active",
    "a=fingerprint:sha-256 11:22:33:44",
    "a=ice-ufrag:near",
    "a=ice-pwd:nearnearnearnearnearnear",
    "a=rtcp-mux",
    "",
  ].join("\r\n")
const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data)

function invite({
  seq = 1,
  toTag,
  body = offer(),
}: {
  seq?: number
  toTag?: string
  body?: string | Uint8Array | null
} = {}): Uint8Array {
  const content = body === null ? new Uint8Array() : typeof body === "string" ? bytes(body) : body
  const head = [
    "INVITE sip:alice@192.0.2.10:5060 SIP/2.0",
    `Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bKi${seq};rport`,
    "Max-Forwards: 70",
    "From: <sip:bob@example.com>;tag=b1",
    `To: <sip:alice@example.com>${toTag ? `;tag=${toTag}` : ""}`,
    "Call-ID: in1",
    `CSeq: ${seq} INVITE`,
    "Contact: <sip:bob@192.0.2.20:5070>",
    ...(body === null ? [] : ["Content-Type: application/sdp"]),
    `Content-Length: ${content.length}`,
    "",
    "",
  ].join("\r\n")
  return new Uint8Array([...bytes(head), ...content])
}

function request(method: string, { seq = 1, toTag = "", body = "" } = {}): Uint8Array {
  return bytes(
    [
      `${method} sip:alice@192.0.2.10:5060 SIP/2.0`,
      `Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bK${method.toLowerCase()}${seq}`,
      "Max-Forwards: 70",
      "From: <sip:bob@example.com>;tag=b1",
      `To: <sip:alice@example.com>;tag=${toTag}`,
      "Call-ID: in1",
      `CSeq: ${seq} ${method}`,
      ...(body === "" ? [] : ["Content-Type: application/sdp"]),
      `Content-Length: ${body.length}`,
      "",
      body,
    ].join("\r\n"),
  )
}

const from = (data: Uint8Array) => ({ type: "receive", data, from: bob }) as const
const command = (value: CoreCommand) => ({ type: "command", command: value }) as const
const phone = (media: "rtp" | "sdp" = "sdp") =>
  createCore({ address: alice, aor: "sip:alice@example.com", random: createRandom(1), media })

function messages(outputs: CoreOutput[]): SipMessage[] {
  return outputs.flatMap((output) => {
    if (output.type !== "send") return []
    const parsed = parseMessage(output.data)
    return parsed.ok ? [parsed.message] : []
  })
}

const responses = (outputs: CoreOutput[]): SipResponse[] =>
  messages(outputs).flatMap((message) => (isRequest(message) ? [] : [message]))
const requests = (outputs: CoreOutput[]): SipRequest[] => messages(outputs).filter(isRequest)
const statuses = (outputs: CoreOutput[]) =>
  responses(outputs).map((response) => `${response.status} ${response.cseq.method}`)
const calls = (outputs: CoreOutput[]) => events(outputs).filter((event) => event.type === "call")

function live() {
  const ua = phone()
  const ring = ua.handle(from(invite()), 0)
  const toTag = responses(ring)[0]?.to.params.get("tag") ?? ""
  ua.handle(command({ type: "accept", call: "in1", media: { sdp: answer() } }), 100)
  const ack = ua.handle(from(request("ACK", { toTag })), 200)
  return { ua, toTag, ring, ack }
}

const description = (type: "offer" | "pranswer" | "answer", sdp: string) => ({
  description: { type, sdp },
})
const rollback = { type: "call", call: "in1", state: "live", description: { type: "rollback" } }

function cancel(seq: number, toTag: string): Uint8Array {
  return bytes(
    [
      "CANCEL sip:alice@192.0.2.10:5060 SIP/2.0",
      `Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bKi${seq};rport`,
      "Max-Forwards: 70",
      "From: <sip:bob@example.com>;tag=b1",
      `To: <sip:alice@example.com>;tag=${toTag}`,
      "Call-ID: in1",
      `CSeq: ${seq} CANCEL`,
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n"),
  )
}

describe('a core with media: "sdp", for calls that come in', () => {
  it("admits a WebRTC offer that a G.711 core refuses, and hands it over as it came", () => {
    expect(statuses(phone("rtp").handle(from(invite()), 0))).toEqual(["488 INVITE"])
    const { ring } = live()
    expect(statuses(ring)).toEqual(["180 INVITE"])
    expect(calls(ring)).toEqual([
      {
        type: "call",
        call: "in1",
        state: "incoming",
        from: { uri: "sip:bob@example.com" },
        to: { uri: "sip:alice@example.com" },
        source: bob,
        ...description("offer", offer()),
      },
    ])
  })

  it.each([
    ["not text", new Uint8Array([0xff, 0xfe])],
    ["not SDP", bytes("hello")],
    ["SDP with a NUL", bytes("v=0\r\n\0")],
  ])("refuses an offer that is %s", (_, body) => {
    expect(statuses(phone().handle(from(invite({ body })), 0))).toEqual(["488 INVITE"])
  })

  it("answers with the app's SDP as it is, and goes live on the ACK with nothing to apply", () => {
    const ua = phone()
    ua.handle(from(invite()), 0)
    const accepted = ua.handle(
      command({ type: "accept", call: "in1", media: { sdp: answer() } }),
      100,
    )
    expect(text(responses(accepted)[0]?.body)).toBe(answer())
    const toTag = responses(accepted)[0]?.to.params.get("tag") ?? ""
    expect(calls(ua.handle(from(request("ACK", { toTag })), 200))).toEqual([
      { type: "call", call: "in1", state: "live" },
    ])
  })

  it("offers the app's SDP for an INVITE without one and passes on the ACK's answer", () => {
    const ua = phone()
    const ring = ua.handle(from(invite({ body: null })), 0)
    expect(calls(ring)[0]).not.toHaveProperty("description")
    const accepted = ua.handle(
      command({ type: "accept", call: "in1", media: { sdp: answer() } }),
      100,
    )
    expect(text(responses(accepted)[0]?.body)).toBe(answer())
    const toTag = responses(accepted)[0]?.to.params.get("tag") ?? ""
    const ack = ua.handle(from(request("ACK", { toTag, body: offer() })), 200)
    expect(calls(ack)).toEqual([
      { type: "call", call: "in1", state: "live", ...description("answer", offer()) },
    ])
  })

  it("hangs up when the ACK to its offer brings no answer", () => {
    const ua = phone()
    ua.handle(from(invite({ body: null })), 0)
    const accepted = ua.handle(
      command({ type: "accept", call: "in1", media: { sdp: answer() } }),
      100,
    )
    const toTag = responses(accepted)[0]?.to.params.get("tag") ?? ""
    const ack = ua.handle(from(request("ACK", { toTag })), 200)
    expect(requests(ack).map((sent) => sent.method)).toEqual(["BYE"])
    expect(getHeader(requests(ack)[0] as SipRequest, "Reason")).toContain("cause=488")
  })

  it("answers a byte-identical refresh with the same SDP and tells nobody", () => {
    const { ua, toTag } = live()
    const refresh = ua.handle(from(invite({ seq: 2, toTag })), 5000)
    expect(statuses(refresh)).toEqual(["200 INVITE"])
    expect(text(responses(refresh)[0]?.body)).toBe(answer())
    expect(calls(refresh)).toEqual([])
  })

  it("asks the app about an offer that changed while its o= did not", () => {
    const { ua, toTag } = live()
    const moved = offer().replace("24436", "24438")
    const asked = ua.handle(from(invite({ seq: 2, toTag, body: moved })), 5000)
    expect(calls(asked)).toEqual([
      { type: "call", call: "in1", state: "offer", ...description("offer", moved) },
    ])
  })

  it("hands a new offer to the app, sends its answer and goes back to live", () => {
    const { ua, toTag } = live()
    const asked = ua.handle(from(invite({ seq: 2, toTag, body: offer(2) })), 5000)
    expect(statuses(asked)).toEqual([])
    expect(calls(asked)).toEqual([
      { type: "call", call: "in1", state: "offer", ...description("offer", offer(2)) },
    ])
    const answered = ua.handle(
      command({ type: "answer", call: "in1", media: { sdp: answer(2) } }),
      5100,
    )
    expect(statuses(answered)).toEqual(["200 INVITE"])
    expect(text(responses(answered)[0]?.body)).toBe(answer(2))
    expect(calls(answered)).toEqual([{ type: "call", call: "in1", state: "live" }])
    expect(ua.handle(from(request("ACK", { seq: 2, toTag })), 5200)).toEqual([])
    const refresh = ua.handle(from(invite({ seq: 3, toTag, body: offer(2) })), 9000)
    expect(text(responses(refresh)[0]?.body)).toBe(answer(2))
  })

  it("asks the app for a fresh offer when a re-INVITE brings none, and passes on the answer", () => {
    const { ua, toTag } = live()
    const asked = ua.handle(from(invite({ seq: 2, toTag, body: null })), 5000)
    expect(calls(asked)).toEqual([{ type: "call", call: "in1", state: "offer" }])
    const offered = ua.handle(
      command({ type: "answer", call: "in1", media: { sdp: answer(3) } }),
      5100,
    )
    expect(text(responses(offered)[0]?.body)).toBe(answer(3))
    expect(calls(offered)).toEqual([])
    const ack = ua.handle(from(request("ACK", { seq: 2, toTag, body: offer(3) })), 5200)
    expect(calls(ack)).toEqual([
      { type: "call", call: "in1", state: "live", ...description("answer", offer(3)) },
    ])
    const next = ua.handle(from(invite({ seq: 3, toTag, body: offer(3) })), 9000)
    expect(calls(next)).toEqual([
      { type: "call", call: "in1", state: "offer", ...description("offer", offer(3)) },
    ])
  })

  it("rolls back its fresh offer when the ACK brings no usable answer", () => {
    const { ua, toTag } = live()
    ua.handle(from(invite({ seq: 2, toTag, body: null })), 5000)
    ua.handle(command({ type: "answer", call: "in1", media: { sdp: answer(3) } }), 5100)
    const ack = ua.handle(from(request("ACK", { seq: 2, toTag })), 5200)
    expect(calls(ack)).toEqual([rollback])
  })

  it("keeps the old session and rolls back when the app never answers", () => {
    const { ua, toTag } = live()
    ua.handle(from(invite({ seq: 2, toTag, body: offer(2) })), 5000)
    expect(ua.nextDeadline()).toBeLessThanOrEqual(15_000)
    expect(statuses(ua.handle({ type: "timeout" }, 5200))).toEqual(["100 INVITE"])
    expect(ua.nextDeadline()).toBe(15_000)
    const refused = ua.handle({ type: "timeout" }, 15_000)
    expect(statuses(refused)).toEqual(["488 INVITE"])
    expect(getHeader(responses(refused)[0] as SipResponse, "Warning")).toBe(
      '399 straw "No answer from the app in time"',
    )
    expect(calls(refused)).toEqual([rollback])
    const late = command({ type: "answer", call: "in1", media: { sdp: answer(2) } })
    expect(ua.handle(late, 15_100)).toEqual([])
    expect(statuses(ua.handle(from(request("BYE", { seq: 3, toTag })), 16_000))).toEqual([
      "200 BYE",
    ])
  })

  it("ends a re-INVITE the far end cancels while the app works, and rolls back", () => {
    const { ua, toTag } = live()
    ua.handle(from(invite({ seq: 2, toTag, body: offer(2) })), 5000)
    const cancelled = ua.handle(from(cancel(2, toTag)), 5100)
    expect(statuses(cancelled).sort()).toEqual(["200 CANCEL", "487 INVITE"])
    expect(calls(cancelled)).toEqual([rollback])
    const late = command({ type: "answer", call: "in1", media: { sdp: answer(2) } })
    expect(ua.handle(late, 5200)).toEqual([])
  })

  it("refuses a re-INVITE whose body is no SDP, without asking the app", () => {
    const { ua, toTag } = live()
    const refused = ua.handle(from(invite({ seq: 2, toTag, body: new Uint8Array([0xff]) })), 5000)
    expect(statuses(refused)).toEqual(["488 INVITE"])
    expect(getHeader(responses(refused)[0] as SipResponse, "Warning")).toMatch(/^305 /)
    expect(calls(refused)).toEqual([])
  })

  it("answers a pending offer with 487 when the far end hangs up, or when we do", () => {
    const remote = live()
    remote.ua.handle(from(invite({ seq: 2, toTag: remote.toTag, body: offer(2) })), 5000)
    const bye = remote.ua.handle(from(request("BYE", { seq: 3, toTag: remote.toTag })), 5100)
    expect(statuses(bye).sort()).toEqual(["200 BYE", "487 INVITE"])
    const local = live()
    local.ua.handle(from(invite({ seq: 2, toTag: local.toTag, body: offer(2) })), 5000)
    const ended = local.ua.handle(command({ type: "end", call: "in1" }), 5100)
    expect(statuses(ended)).toEqual(["487 INVITE"])
    expect(requests(ended).map((sent) => sent.method)).toEqual(["BYE"])
  })

  it("asks a second offer to retry while the first waits for the app", () => {
    const { ua, toTag } = live()
    ua.handle(from(invite({ seq: 2, toTag, body: offer(2) })), 5000)
    const second = ua.handle(from(invite({ seq: 3, toTag, body: offer(3) })), 5100)
    expect(statuses(second)).toEqual(["500 INVITE"])
  })
})

describe('a core with media: "sdp", for calls it makes', () => {
  const dial = (ua: ReturnType<typeof phone>) =>
    requests(
      ua.handle(
        command({
          type: "call",
          call: "c1",
          uri: "sip:bob@example.com",
          to: bob,
          media: { sdp: offer() },
        }),
        0,
      ),
    )[0] as SipRequest
  const answering = (sent: SipRequest, status: number, tag: string, body: Uint8Array) =>
    from(serializeMessage({ ...createResponse(sent, status, "Reason", { toTag: tag }), body }))

  it("calls with the app's SDP and passes on a pranswer and the answer", () => {
    const ua = phone()
    const sent = dial(ua)
    expect(text(sent.body)).toBe(offer())
    expect(calls(ua.handle(answering(sent, 183, "t1", bytes(answer())), 100))).toEqual([
      {
        type: "call",
        call: "c1",
        state: "ringing",
        status: 183,
        ...description("pranswer", answer()),
      },
    ])
    expect(calls(ua.handle(answering(sent, 200, "t1", bytes(answer(2))), 200))).toEqual([
      { type: "call", call: "c1", state: "live", ...description("answer", answer(2)) },
    ])
  })

  it("takes the early SDP of the fork that answers without one", () => {
    const ua = phone()
    const sent = dial(ua)
    ua.handle(answering(sent, 183, "t1", bytes(answer())), 100)
    ua.handle(answering(sent, 183, "t2", bytes(answer(5))), 110)
    expect(calls(ua.handle(answering(sent, 200, "t1", new Uint8Array()), 200))).toEqual([
      { type: "call", call: "c1", state: "live", ...description("answer", answer()) },
    ])
  })

  it("hangs up an answer that is no SDP, as incompatible", () => {
    const ua = phone()
    const sent = dial(ua)
    const outputs = ua.handle(answering(sent, 200, "t1", new Uint8Array([0xff])), 100)
    expect(requests(outputs).map((request) => request.method)).toEqual(["ACK", "BYE"])
  })
})

describe('a core with media: "sdp", checking its input', () => {
  const call = (media: never) =>
    command({ type: "call", call: "c1", uri: "sip:bob@example.com", to: bob, media })

  it("refuses media the core is not set up for", () => {
    expect(() => phone().handle(call(aliceMedia as never), 0)).toThrow(
      new TypeError(
        'With media: "sdp", calls take { sdp } with an SDP, got {"host":"192.0.2.10","port":40000}',
      ),
    )
    expect(() => phone().handle(call({ sdp: "x" } as never), 0)).toThrow(TypeError)
    expect(() => phone().handle(call({ sdp: "v=0\r\n\0" } as never), 0)).toThrow(TypeError)
    expect(() => phone("rtp").handle(call({ sdp: offer() } as never), 0)).toThrow(
      new TypeError('{ sdp } needs a core with media: "sdp"'),
    )
    expect(() =>
      phone("rtp").handle(command({ type: "answer", call: "in1", media: { sdp: answer() } }), 0),
    ).toThrow(new TypeError('answer needs a core with media: "sdp"'))
    expect(() =>
      createCore({
        address: alice,
        aor: "sip:alice@example.com",
        random: createRandom(1),
        media: "webrtc" as never,
      }),
    ).toThrow(new TypeError('media must be "rtp" or "sdp", got "webrtc"'))
  })

  it("measures an SDP in bytes, as it goes out", () => {
    const wide = `v=0\r\n${"ä".repeat(16_385)}`
    expect(() => phone().handle(call({ sdp: wide } as never), 0)).toThrow(
      new RangeError("An SDP must be at most 32768 bytes, got 32775"),
    )
  })

  it("does nothing for an answer before the call is answered either way", () => {
    const ua = phone()
    ua.handle(from(invite()), 0)
    expect(
      ua.handle(command({ type: "answer", call: "in1", media: { sdp: answer() } }), 10),
    ).toEqual([])
    ua.handle(call({ sdp: offer() } as never), 20)
    expect(
      ua.handle(command({ type: "answer", call: "c1", media: { sdp: answer() } }), 30),
    ).toEqual([])
  })

  it("does nothing for an answer nobody asked for", () => {
    expect(
      phone().handle(command({ type: "answer", call: "nope", media: { sdp: answer() } }), 0),
    ).toEqual([])
    const { ua } = live()
    expect(
      ua.handle(command({ type: "answer", call: "in1", media: { sdp: answer() } }), 300),
    ).toEqual([])
  })
})
