import { describe, expect, it } from "vitest"
import {
  type CoreCommand,
  type CoreEvent,
  type CoreOutput,
  createCore,
  createResponse,
  getHeader,
  getHeaders,
  isRequest,
  type MediaAddress,
  parseMessage,
  type SipMessage,
  type SipRequest,
  type SipResponse,
  serializeMessage,
} from "../../src/core"
import { createRandom } from "../../src/simulation/random"
import { alice, aliceMedia, bob, bytes, sdp } from "../helpers"

const local = aliceMedia
const remote = sdp()
const hold = sdp({ direction: "sendonly", version: 2 })
const negotiated = {
  remote: { host: "192.0.2.20", port: 4000 },
  codec: "PCMU",
  payloadType: 0,
  ptime: 20,
  direction: "sendrecv",
} as const
const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data)

interface InviteOptions {
  readonly callId?: string
  readonly branch?: string
  readonly seq?: number
  readonly body?: string | null
  readonly extra?: readonly string[]
  readonly toTag?: string
  readonly fromTag?: string
}

function invite(options: InviteOptions = {}): string {
  const { callId = "in1", branch = "z9hG4bKi1", seq = 1, body = remote, extra = [] } = options
  const { toTag, fromTag = "b1" } = options
  const content = body ?? ""
  return [
    "INVITE sip:alice@192.0.2.10:5060 SIP/2.0",
    `Via: SIP/2.0/UDP 192.0.2.20:5060;branch=${branch};rport`,
    "Max-Forwards: 70",
    `From: "Bob" <sip:bob@example.com>;tag=${fromTag}`,
    `To: <sip:alice@example.com>${toTag ? `;tag=${toTag}` : ""}`,
    `Call-ID: ${callId}`,
    `CSeq: ${seq} INVITE`,
    "Contact: <sip:bob@192.0.2.20:5070>",
    "Record-Route: <sip:p2.example.com;lr>, <sip:p1.example.com;lr>",
    ...(body === null ? [] : ["Content-Type: application/sdp"]),
    ...extra,
    `Content-Length: ${content.length}`,
    "",
    content,
  ].join("\r\n")
}

interface RequestOptions {
  readonly seq?: number
  readonly branch?: string
  readonly toTag?: string
  readonly fromTag?: string
  readonly body?: string
  readonly callId?: string
  readonly extra?: readonly string[]
}

function request(method: string, options: RequestOptions = {}): string {
  const { seq = 1, branch = `z9hG4bK${method.toLowerCase()}`, toTag, body = "" } = options
  const { fromTag = "b1", callId = "in1", extra = [] } = options
  return [
    `${method} sip:alice@192.0.2.10:5060 SIP/2.0`,
    `Via: SIP/2.0/UDP 192.0.2.20:5060;branch=${branch}`,
    "Max-Forwards: 70",
    `From: "Bob" <sip:bob@example.com>;tag=${fromTag}`,
    `To: <sip:alice@example.com>${toTag ? `;tag=${toTag}` : ""}`,
    `Call-ID: ${callId}`,
    `CSeq: ${seq} ${method}`,
    ...(body === "" ? [] : ["Content-Type: application/sdp"]),
    ...extra,
    `Content-Length: ${body.length}`,
    "",
    body,
  ].join("\r\n")
}

const receive = (text: string) => ({ type: "receive", data: bytes(text), from: bob }) as const
const timeout = { type: "timeout" } as const
const command = (value: CoreCommand) => ({ type: "command", command: value }) as const
const accept = (call = "in1", media: MediaAddress = local) =>
  command({ type: "accept", call, media })
const end = (status?: number, call = "in1") =>
  command(status === undefined ? { type: "end", call } : { type: "end", call, status })

function phone(maxCalls?: number) {
  return createCore({
    address: alice,
    aor: "sip:alice@example.com",
    random: createRandom(1),
    credentials: { username: "alice", password: "secret" },
    ...(maxCalls === undefined ? {} : { maxCalls }),
  })
}

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
const statuses = (outputs: CoreOutput[]): string[] =>
  responses(outputs).map((response) => `${response.status} ${response.cseq.method}`)
const events = (outputs: CoreOutput[]): CoreEvent[] =>
  outputs.flatMap((output) => (output.type === "event" ? [output.event] : []))
const calls = (outputs: CoreOutput[]) => events(outputs).filter((event) => event.type === "call")

function reply(to: SipRequest, status: number, headers: { name: string; value: string }[] = []) {
  const response = createResponse(to, status, "Reason", { headers })
  return { type: "receive", data: serializeMessage(response), from: bob } as const
}

function ringing(text = invite(), ua = phone()) {
  const outputs = ua.handle(receive(text), 0)
  const [ring] = responses(outputs)
  const ourTag = ring?.to.params.get("tag") ?? ""
  return { ua, outputs, ourTag }
}

function answered() {
  const ring = ringing()
  return { ...ring, answer: ring.ua.handle(accept(), 1000) }
}

function acked() {
  const call = answered()
  const ack = call.ua.handle(receive(request("ACK", { toTag: call.ourTag })), 1100)
  return { ...call, ack }
}

function run(ua: ReturnType<typeof phone>, from: number, to: number): [number, CoreOutput[]][] {
  const steps: [number, CoreOutput[]][] = []
  for (let at = ua.nextDeadline(); at !== undefined && at >= from && at <= to; ) {
    const outputs = ua.handle(timeout, at)
    if (outputs.length > 0) steps.push([at, outputs])
    at = ua.nextDeadline()
  }
  return steps
}

describe("incoming calls (RFC 3261 §13.3)", () => {
  it("rings with 180 and reports the caller and the offer", () => {
    const { outputs, ourTag } = ringing()
    expect(outputs.map((output) => output.type)).toStrictEqual(["send", "event"])
    const [ring] = responses(outputs)
    expect(ring).toMatchObject({
      status: 180,
      reason: "Ringing",
      cseq: { seq: 1, method: "INVITE" },
    })
    expect(ourTag).toMatch(/^[a-z0-9]{10}$/)
    expect(ring?.contact).toStrictEqual([{ uri: "sip:alice@192.0.2.10:5060", params: new Map() }])
    expect(ring && getHeaders(ring, "Record-Route")).toStrictEqual([
      "<sip:p2.example.com;lr>, <sip:p1.example.com;lr>",
    ])
    expect(ring && getHeader(ring, "Allow")).toBe("ACK, BYE, CANCEL, INVITE, OPTIONS")
    expect(ring?.body).toStrictEqual(new Uint8Array())
    expect(events(outputs)).toStrictEqual([
      {
        type: "call",
        call: "in1",
        state: "incoming",
        from: { uri: "sip:bob@example.com", name: "Bob" },
        to: { uri: "sip:alice@example.com" },
        source: bob,
      },
    ])
  })

  it("reports a caller without a display name or offer", () => {
    const text = invite({ body: null }).replace('"Bob" <sip', "<sip")
    expect(events(ringing(text).outputs)).toStrictEqual([
      {
        type: "call",
        call: "in1",
        state: "incoming",
        from: { uri: "sip:bob@example.com" },
        to: { uri: "sip:alice@example.com" },
        source: bob,
      },
    ])
  })

  it("treats an empty display name as none", () => {
    const text = invite().replace('"Bob" <sip', '"" <sip')
    expect(events(ringing(text).outputs)[0]).toMatchObject({ from: { uri: "sip:bob@example.com" } })
    expect(events(ringing(text).outputs)[0]).not.toHaveProperty("from.name")
  })

  it("lets a stray 2xx with its Call-ID pass while it rings", () => {
    const { ua } = ringing()
    const stray = [
      "SIP/2.0 200 OK",
      "Via: SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bKnothing",
      'From: "Bob" <sip:bob@example.com>;tag=b1',
      "To: <sip:alice@example.com>;tag=x",
      "Call-ID: in1",
      "CSeq: 1 INVITE",
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n")
    expect(ua.handle(receive(stray), 10)).toStrictEqual([])
  })

  it("answers a retransmitted INVITE with the same 180 and reports the call once", () => {
    const { ua, outputs } = ringing()
    const again = ua.handle(receive(invite()), 400)
    expect(responses(again)).toStrictEqual(responses(outputs))
    expect(events(again)).toStrictEqual([])
  })

  it("sends no 100 Trying because the 180 went out at once", () => {
    const { ua } = ringing()
    for (let now = 100; now <= 1000; now += 100) expect(ua.handle(timeout, now)).toStrictEqual([])
  })

  it("repeats the 180 every minute while it rings (§13.3.1.1)", () => {
    const { ua, outputs } = ringing()
    const steps = run(ua, 0, 130_000)
    expect(steps.map(([at, step]) => [at, statuses(step)])).toStrictEqual([
      [60_000, ["180 INVITE"]],
      [120_000, ["180 INVITE"]],
    ])
    expect(responses(steps[0]?.[1] ?? [])).toStrictEqual(responses(outputs))
  })

  it("answers with 200, our SDP, our tag, Contact and the Record-Route, live only on the ACK", () => {
    const { answer: outputs, ourTag } = answered()
    const [ok] = responses(outputs)
    expect(ok).toMatchObject({ status: 200, reason: "OK" })
    expect(ok?.to.params.get("tag")).toBe(ourTag)
    expect(text(ok?.body)).toContain("c=IN IP4 192.0.2.10\r\nt=0 0\r\nm=audio 40000 RTP/AVP 0\r\n")
    expect(text(ok?.body)).toContain("a=sendrecv\r\n")
    expect(ok && getHeader(ok, "Content-Type")).toBe("application/sdp")
    expect(ok?.contact).toStrictEqual([{ uri: "sip:alice@192.0.2.10:5060", params: new Map() }])
    expect(ok && getHeaders(ok, "Record-Route")).toStrictEqual([
      "<sip:p2.example.com;lr>, <sip:p1.example.com;lr>",
    ])
    expect(calls(outputs)).toStrictEqual([])
  })

  it("answers only once and ignores answers for unknown calls", () => {
    const { ua } = answered()
    expect(ua.handle(accept(), 1001)).toStrictEqual([])
    expect(ua.handle(accept("unknown"), 1001)).toStrictEqual([])
  })

  it("copies the media address so later changes to the caller's object do not leak", () => {
    const { ua } = ringing()
    const media = { host: "192.0.2.10", port: 40_000 }
    const [ok] = responses(ua.handle(accept("in1", media), 1000))
    media.port = 1
    const [again] = responses(ua.handle(timeout, 1500))
    expect(again?.body).toStrictEqual(ok?.body)
    expect(text(again?.body)).toContain("m=audio 40000 ")
  })

  it("resends the 200 with T1 doubling up to T2 until 64·T1, then hangs up (§13.3.1.4)", () => {
    const { ua } = answered()
    const steps = run(ua, 1000, 33_000)
    expect(
      steps.map(([at, step]) => [at, statuses(step), requests(step).map((r) => r.method)]),
    ).toStrictEqual([
      [1500, ["200 INVITE"], []],
      [2500, ["200 INVITE"], []],
      [4500, ["200 INVITE"], []],
      [8500, ["200 INVITE"], []],
      [12_500, ["200 INVITE"], []],
      [16_500, ["200 INVITE"], []],
      [20_500, ["200 INVITE"], []],
      [24_500, ["200 INVITE"], []],
      [28_500, ["200 INVITE"], []],
      [32_500, ["200 INVITE"], []],
      [33_000, [], ["BYE"]],
    ])
    const [bye] = requests(steps.at(-1)?.[1] ?? [])
    if (!bye) throw new Error("No BYE")
    expect(calls(ua.handle(reply(bye, 200), 33_100))).toStrictEqual([
      { type: "call", call: "in1", state: "ended", ended: { by: "remote", reason: "dropped" } },
    ])
  })

  it("stops resending the 200 once the ACK arrives", () => {
    const { ua, ack } = acked()
    expect(calls(ack)).toStrictEqual([
      { type: "call", call: "in1", state: "live", media: negotiated },
    ])
    expect(ua.nextDeadline()).toBe(33_000)
    expect(run(ua, 1100, 40_000)).toStrictEqual([])
    expect(ua.nextDeadline()).toBeUndefined()
  })

  it.each([
    ["another CSeq", { seq: 2 }],
    ["another To tag", { toTag: "other" }],
    ["another From tag", { fromTag: "b2" }],
  ])("keeps resending when the ACK has %s", (_, options) => {
    const { ua, ourTag } = answered()
    expect(ua.handle(receive(request("ACK", { toTag: ourTag, ...options })), 1100)).toStrictEqual(
      [],
    )
    expect(statuses(ua.handle(timeout, 1500))).toStrictEqual(["200 INVITE"])
  })

  it("takes the answer to its own offer from the ACK (late offer)", () => {
    const { ua, outputs, ourTag } = ringing(invite({ body: null }))
    expect(events(outputs)).toMatchObject([{ state: "incoming" }])
    expect(events(outputs)[0]).not.toHaveProperty("sdp")
    const [ok] = responses(ua.handle(accept(), 1000))
    expect(text(ok?.body)).toContain("m=audio 40000 RTP/AVP 0 8\r\n")
    const ack = ua.handle(receive(request("ACK", { toTag: ourTag, body: remote })), 1100)
    expect(calls(ack)).toStrictEqual([
      { type: "call", call: "in1", state: "live", media: negotiated },
    ])
  })

  it("goes live with its own answer when the ACK repeats the offer", () => {
    const { ua, ourTag } = answered()
    expect(
      calls(ua.handle(receive(request("ACK", { toTag: ourTag, body: remote })), 1100)),
    ).toStrictEqual([{ type: "call", call: "in1", state: "live", media: negotiated }])
  })

  it("hangs up with a BYE to the caller's Contact along the recorded route", () => {
    const { ua, ourTag } = acked()
    const outputs = ua.handle(end(), 2000)
    const [bye] = requests(outputs)
    expect(outputs[0]).toMatchObject({ type: "send", to: bob })
    expect(bye).toMatchObject({
      method: "BYE",
      uri: "sip:bob@192.0.2.20:5070",
      callId: "in1",
      cseq: { seq: 1, method: "BYE" },
    })
    expect(bye?.from.params.get("tag")).toBe(ourTag)
    expect(bye?.from.uri).toBe("sip:alice@example.com")
    expect(bye?.to).toMatchObject({ uri: "sip:bob@example.com", displayName: "Bob" })
    expect(bye?.to.params.get("tag")).toBe("b1")
    expect(bye && getHeaders(bye, "Route")).toStrictEqual([
      "<sip:p2.example.com;lr>",
      "<sip:p1.example.com;lr>",
    ])
    if (!bye) throw new Error("No BYE")
    expect(calls(ua.handle(reply(bye, 200), 2100))).toStrictEqual([
      { type: "call", call: "in1", state: "ended", ended: { by: "local", reason: "hangup" } },
    ])
    expect(ua.handle(end(), 2200)).toStrictEqual([])
  })

  it("ends when the answer to its BYE carries a To tag it did not expect", () => {
    const { ua } = acked()
    const [bye] = requests(ua.handle(end(), 2000))
    if (!bye) throw new Error("No BYE")
    const odd = createResponse(bye, 200, "OK", { toTag: "other" })
    const unexpected = { ...odd, to: { ...odd.to, params: new Map([["tag", "other"]]) } }
    const data = serializeMessage(unexpected)
    expect(calls(ua.handle({ type: "receive", data, from: bob }, 2100))).toMatchObject([
      { state: "ended", ended: { by: "local", reason: "hangup" } },
    ])
  })

  it("ignores a status when it hangs up a call that is already live", () => {
    const { ua } = acked()
    expect(requests(ua.handle(end(603), 2000)).map((r) => r.method)).toStrictEqual(["BYE"])
  })

  it("answers with the Contact of the connection it moved to while ringing", () => {
    const ua = phone()
    ringing(invite(), ua)
    const address = { ...alice, port: 5062 }
    ua.handle({ type: "command", command: { type: "move", address } }, 500)
    const [ok] = responses(ua.handle(accept(), 1000))
    expect(ok?.contact).toStrictEqual([{ uri: "sip:alice@192.0.2.10:5062", params: new Map() }])
  })

  it("lets a caller outside acceptFrom keep up and finish a call the server put through", () => {
    const ua = createCore({
      address: alice,
      aor: "sip:alice@example.com",
      random: createRandom(1),
      acceptFrom: ["192.0.2.20"],
    })
    const { ourTag } = ringing(invite(), ua)
    ua.handle(accept(), 1000)
    const direct = { ...bob, host: "198.51.100.7" }
    for (const toTag of ["guessed", undefined]) {
      const guess = request("ACK", toTag ? { toTag } : {})
      expect(ua.handle({ type: "receive", data: bytes(guess), from: direct }, 1050)).toMatchObject([
        { event: { type: "invalid", error: "ACK from 198.51.100.7, not an accepted host" } },
      ])
    }
    const ack = request("ACK", { toTag: ourTag })
    expect(
      calls(ua.handle({ type: "receive", data: bytes(ack), from: direct }, 1100)),
    ).toMatchObject([{ state: "live" }])
    const from = (data: string, at: number) =>
      ua.handle({ type: "receive", data: bytes(data), from: direct }, at)
    expect(statuses(from(request("OPTIONS", { toTag: ourTag, seq: 2 }), 1200))).toStrictEqual([
      "200 OPTIONS",
    ])
    expect(statuses(from(request("INFO", { toTag: ourTag, seq: 3 }), 1300))).toStrictEqual([
      "405 INFO",
    ])
    expect(from(request("OPTIONS", { toTag: "guessed", seq: 4 }), 1400)).toMatchObject([
      { event: { type: "invalid", error: "OPTIONS from 198.51.100.7, not an accepted host" } },
    ])
    const outputs = from(request("BYE", { toTag: ourTag, seq: 5 }), 2000)
    expect(statuses(outputs)).toStrictEqual(["200 BYE"])
    expect(calls(outputs)).toMatchObject([{ state: "ended", ended: { reason: "hangup" } }])
  })

  it("never answers a challenge to its BYE, which may come from the caller", () => {
    const { ua } = acked()
    const [bye] = requests(ua.handle(end(), 2000))
    if (!bye) throw new Error("No BYE")
    const challenge = { name: "WWW-Authenticate", value: 'Digest realm="example.com", nonce="n1"' }
    const outputs = ua.handle(reply(bye, 401, [challenge]), 2100)
    expect(requests(outputs)).toStrictEqual([])
    expect(calls(outputs)).toMatchObject([{ state: "ended", ended: { reason: "hangup" } }])
  })

  it("waits for the ACK before it sends the BYE (§15)", () => {
    const { ua, ourTag } = answered()
    expect(ua.handle(end(), 1050)).toStrictEqual([])
    expect(statuses(ua.handle(timeout, 1500))).toStrictEqual(["200 INVITE"])
    const ack = ua.handle(receive(request("ACK", { toTag: ourTag })), 1600)
    expect(requests(ack).map((r) => r.method)).toStrictEqual(["BYE"])
    expect(calls(ack)).toStrictEqual([])
  })

  it("sends the waiting BYE when the ACK never comes and ends as a local hangup", () => {
    const { ua } = answered()
    ua.handle(end(), 1050)
    const steps = run(ua, 1050, 33_000)
    const [bye] = requests(steps.at(-1)?.[1] ?? [])
    expect(steps.at(-1)?.[0]).toBe(33_000)
    if (!bye) throw new Error("No BYE")
    expect(calls(ua.handle(reply(bye, 200), 33_100))).toStrictEqual([
      { type: "call", call: "in1", state: "ended", ended: { by: "local", reason: "hangup" } },
    ])
  })

  it("ends when the caller hangs up, and answers later BYEs with 481", () => {
    const { ua, ourTag } = acked()
    const bye = ua.handle(receive(request("BYE", { toTag: ourTag, seq: 2 })), 2000)
    expect(statuses(bye)).toStrictEqual(["200 BYE"])
    expect(calls(bye)).toStrictEqual([
      { type: "call", call: "in1", state: "ended", ended: { by: "remote", reason: "hangup" } },
    ])
    const later = ua.handle(
      receive(request("BYE", { toTag: ourTag, seq: 3, branch: "z9hG4bKb2" })),
      2100,
    )
    expect(statuses(later)).toStrictEqual(["481 BYE"])
  })

  it("accepts a BYE that overtakes the ACK and stops resending the 200", () => {
    const { ua, ourTag } = answered()
    const bye = ua.handle(receive(request("BYE", { toTag: ourTag, seq: 2 })), 1200)
    expect(statuses(bye)).toStrictEqual(["200 BYE"])
    expect(calls(bye)).toMatchObject([
      { state: "ended", ended: { by: "remote", reason: "hangup" } },
    ])
    expect(run(ua, 1200, 40_000).flatMap(([, step]) => statuses(step))).toStrictEqual([])
  })

  it("rejects the call with 486 Busy Here by default", () => {
    const { ua, ourTag } = ringing()
    const outputs = ua.handle(end(), 500)
    const [busy] = responses(outputs)
    expect(busy).toMatchObject({ status: 486, reason: "Busy Here" })
    expect(busy?.to.params.get("tag")).toBe(ourTag)
    expect(busy?.contact).toStrictEqual([])
    expect(calls(outputs)).toStrictEqual([
      {
        type: "call",
        call: "in1",
        state: "ended",
        ended: { by: "local", reason: "busy", status: 486 },
      },
    ])
    expect(
      ua.handle(receive(request("ACK", { toTag: ourTag, branch: "z9hG4bKi1" })), 600),
    ).toStrictEqual([])
    expect(ua.handle(end(), 700)).toStrictEqual([])
    expect(ua.handle(accept(), 700)).toStrictEqual([])
  })

  it.each([
    [603, "Decline", "declined"],
    [480, "Temporarily Unavailable", "no-answer"],
    [404, "Not Found", "not-found"],
    [488, "Not Acceptable Here", "incompatible"],
    [499, "Rejected", "rejected"],
  ])("rejects with %i %s", (status, phrase, reason) => {
    const { ua } = ringing()
    const outputs = ua.handle(end(status), 500)
    expect(responses(outputs)).toMatchObject([{ status, reason: phrase }])
    expect(calls(outputs)).toMatchObject([{ ended: { by: "local", reason, status } }])
  })

  it("ends with 487 when the caller cancels (§9.2)", () => {
    const { ua, ourTag } = ringing()
    const outputs = ua.handle(receive(request("CANCEL", { branch: "z9hG4bKi1" })), 500)
    const [ok, terminated] = responses(outputs)
    expect(statuses(outputs)).toStrictEqual(["200 CANCEL", "487 INVITE"])
    expect(ok?.to.params.get("tag")).toBe(ourTag)
    expect(terminated?.to.params.get("tag")).toBe(ourTag)
    expect(terminated?.reason).toBe("Request Terminated")
    expect(calls(outputs)).toStrictEqual([
      { type: "call", call: "in1", state: "ended", ended: { by: "remote", reason: "cancelled" } },
    ])
    expect(
      ua.handle(receive(request("ACK", { toTag: ourTag, branch: "z9hG4bKi1" })), 600),
    ).toStrictEqual([])
    const again = ua.handle(receive(request("CANCEL", { branch: "z9hG4bKi1" })), 650)
    expect(statuses(again)).toStrictEqual(["200 CANCEL"])
    expect(ua.handle(accept(), 700)).toStrictEqual([])
  })

  it.each([
    [['Reason: SIP;cause=200;text="Call completed elsewhere"'], "answered-elsewhere"],
    [['Reason: SIP ;cause=200 ;text="Call completed elsewhere"'], "answered-elsewhere"],
    [["Reason: Q.850;cause=16, sip; Cause = 200"], "answered-elsewhere"],
    [["Reason: Q.850;cause=16", "Reason: SIP;cause=200"], "answered-elsewhere"],
    [["Reason: Q.850;cause=200"], "cancelled"],
    [["Reason: SIP;cause=2000"], "cancelled"],
    [["Reason: SIP;cause=487"], "cancelled"],
    [['Reason: SIP;text="cause=200"'], "cancelled"],
    [['Reason: SIP;text="busy, SIP;cause=200"'], "cancelled"],
    [['Reason: SIP;text="never closed;cause=200'], "cancelled"],
  ])("tells a call answered elsewhere from a cancelled one (RFC 3326): %j", (extra, reason) => {
    const { ua } = ringing()
    const cancel = request("CANCEL", { branch: "z9hG4bKi1", extra })
    const outputs = ua.handle(receive(cancel), 500)
    expect(statuses(outputs)).toStrictEqual(["200 CANCEL", "487 INVITE"])
    expect(calls(outputs)).toMatchObject([{ ended: { by: "remote", reason } }])
  })

  it("answers a CANCEL after a rejection with 200 and nothing else", () => {
    const { ua } = ringing()
    ua.handle(end(), 500)
    const outputs = ua.handle(receive(request("CANCEL", { branch: "z9hG4bKi1" })), 600)
    expect(statuses(outputs)).toStrictEqual(["200 CANCEL"])
    expect(calls(outputs)).toStrictEqual([])
  })

  it("keeps the call when a CANCEL crosses the 200, and tags the 200 for the CANCEL", () => {
    const { ua, ourTag } = answered()
    const outputs = ua.handle(receive(request("CANCEL", { branch: "z9hG4bKi1" })), 1050)
    expect(statuses(outputs)).toStrictEqual(["200 CANCEL"])
    expect(responses(outputs)[0]?.to.params.get("tag")).toBe(ourTag)
    expect(calls(outputs)).toStrictEqual([])
  })

  it("only cancels the INVITE the CANCEL matches, not another one with its Call-ID", () => {
    const { ua, ourTag } = ringing()
    ua.handle(receive(invite({ toTag: ourTag, seq: 2, branch: "z9hG4bKi2" })), 100)
    const outputs = ua.handle(receive(request("CANCEL", { seq: 2, branch: "z9hG4bKi2" })), 200)
    expect(statuses(outputs)).toStrictEqual(["200 CANCEL"])
    expect(calls(outputs)).toStrictEqual([])
    expect(responses(ua.handle(accept(), 300))).toMatchObject([{ status: 200 }])
  })

  it("gives up ringing after three minutes with 480 (like a proxy's Timer C)", () => {
    const { ua, ourTag } = ringing()
    const steps = run(ua, 0, 180_000)
    expect(steps.map(([at, step]) => [at, statuses(step)])).toStrictEqual([
      [60_000, ["180 INVITE"]],
      [120_000, ["180 INVITE"]],
      [180_000, ["480 INVITE"]],
    ])
    const [unavailable] = responses(steps.at(-1)?.[1] ?? [])
    expect(unavailable?.reason).toBe("Temporarily Unavailable")
    expect(unavailable?.to.params.get("tag")).toBe(ourTag)
    expect(calls(steps.at(-1)?.[1] ?? [])).toStrictEqual([
      {
        type: "call",
        call: "in1",
        state: "ended",
        ended: { by: "local", reason: "no-answer", status: 480 },
      },
    ])
  })

  it("ends the invitation with 487 when the INVITE's Expires runs out (§13.3.1)", () => {
    const { ua } = ringing(invite({ extra: ["Expires: 5"] }))
    const steps = run(ua, 0, 5000)
    expect(steps.map(([at, step]) => [at, statuses(step)])).toStrictEqual([[5000, ["487 INVITE"]]])
    expect(calls(steps[0]?.[1] ?? [])).toMatchObject([
      { state: "ended", ended: { by: "remote", reason: "no-answer" } },
    ])
  })

  it.each([
    ["an Expires longer than the ring limit", "Expires: 600"],
    ["an Expires as long as the ring limit", "Expires: 180"],
    ["a broken Expires", "Expires: soon"],
    ["an Expires in another notation", "Expires: 1e2"],
  ])("rings for three minutes with %s", (_, header) => {
    const { ua } = ringing(invite({ extra: [header] }))
    const steps = run(ua, 0, 180_000)
    expect(steps.map(([at, step]) => [at, statuses(step)]).at(-1)).toStrictEqual([
      180_000,
      ["480 INVITE"],
    ])
  })

  it("keeps ringing and refreshing until an Expires beyond a minute runs out", () => {
    const { ua } = ringing(invite({ extra: ["Expires: 100"] }))
    expect(run(ua, 0, 100_000).map(([at, step]) => [at, statuses(step)])).toStrictEqual([
      [60_000, ["180 INVITE"]],
      [100_000, ["487 INVITE"]],
    ])
  })

  it("does not give up on a call it answered", () => {
    const { ua } = acked()
    expect(run(ua, 1100, 400_000)).toStrictEqual([])
  })

  it("ends with 487 when the caller sends BYE on the early dialog (§15.1.2)", () => {
    const { ua, ourTag } = ringing()
    const outputs = ua.handle(receive(request("BYE", { toTag: ourTag, seq: 2 })), 500)
    expect(statuses(outputs)).toStrictEqual(["200 BYE", "487 INVITE"])
    expect(calls(outputs)).toMatchObject([{ ended: { by: "remote", reason: "cancelled" } }])
    const late = ua.handle(
      receive(request("BYE", { toTag: ourTag, seq: 3, branch: "z9hG4bKb3" })),
      600,
    )
    expect(statuses(late)).toStrictEqual(["481 BYE"])
  })

  it("asks a second INVITE on the early dialog to retry later (§14.2)", () => {
    const { ua, ourTag } = ringing()
    const outputs = ua.handle(receive(invite({ toTag: ourTag, seq: 2, branch: "z9hG4bKi2" })), 500)
    const [retry] = responses(outputs)
    expect(retry).toMatchObject({ status: 500, reason: "Server Internal Error" })
    expect(Number(retry && getHeader(retry, "Retry-After"))).toBeGreaterThanOrEqual(0)
    expect(Number(retry && getHeader(retry, "Retry-After"))).toBeLessThanOrEqual(10)
  })

  it("keeps ringing calls apart by Call-ID", () => {
    const ua = phone()
    ringing(invite(), ua)
    const second = ua.handle(receive(invite({ callId: "in2", branch: "z9hG4bKi2" })), 10)
    expect(events(second)).toMatchObject([{ call: "in2", state: "incoming" }])
    const [busy] = responses(ua.handle(end(486, "in2"), 20))
    expect(busy?.callId).toBe("in2")
    expect(responses(ua.handle(accept(), 30))).toMatchObject([{ status: 200, callId: "in1" }])
  })
})

describe("admitting INVITEs (RFC 3261 §8.2)", () => {
  it.each([
    ["a required extension", invite({ extra: ["Require: 100rel"] }), 420],
    ["a body that is not SDP", invite().replace("application/sdp", "text/plain"), 415],
    [
      "an unsupported scheme",
      invite().replace("INVITE sip:alice@192.0.2.10:5060", "INVITE tel:+4930123"),
      416,
    ],
  ])("refuses an INVITE with %s statelessly", (_, text, status) => {
    const ua = phone()
    const outputs = ua.handle(receive(text), 0)
    expect(events(outputs)).toMatchObject([{ type: "answered", status }])
    expect(responses(outputs)).toMatchObject([{ status }])
    expect(ua.nextDeadline()).toBeUndefined()
  })

  it("refuses an offer it cannot play with 488 before it rings (RFC 3264 §6)", () => {
    const ua = phone()
    const outputs = ua.handle(receive(invite({ body: sdp({ formats: [18] }) })), 0)
    expect(events(outputs)).toMatchObject([{ type: "answered", status: 488 }])
    expect(responses(outputs)).toMatchObject([{ status: 488, reason: "Not Acceptable Here" }])
    expect(ua.nextDeadline()).toBeUndefined()
  })

  it("refuses a second INVITE with a Call-ID it already knows as a loop (§8.2.2.2)", () => {
    const { ua } = ringing()
    const outputs = ua.handle(receive(invite({ branch: "z9hG4bKother", fromTag: "b9" })), 10)
    expect(responses(outputs)).toMatchObject([{ status: 482, reason: "Loop Detected" }])
    expect(calls(outputs)).toStrictEqual([])
  })

  it("refuses its own outgoing call coming back as a loop", () => {
    const ua = phone()
    const [own] = requests(
      ua.handle(
        command({ type: "call", call: "own", uri: "sip:alice@example.com", to: bob, media: local }),
        0,
      ),
    )
    if (!own) throw new Error("No INVITE")
    const looped = { type: "receive", data: serializeMessage(own), from: bob } as const
    expect(responses(ua.handle(looped, 10))).toMatchObject([{ status: 482 }])
  })

  it("lets a caller retry with the same Call-ID after it rejected the first INVITE", () => {
    const { ua } = ringing()
    ua.handle(end(488), 100)
    const retry = ua.handle(receive(invite({ seq: 2, branch: "z9hG4bKi2" })), 200)
    expect(events(retry)).toMatchObject([{ call: "in1", state: "incoming" }])
    expect(responses(ua.handle(accept(), 300))).toMatchObject([
      { status: 200, cseq: { seq: 2, method: "INVITE" } },
    ])
  })

  it("takes a new caller on a Call-ID whose rejected call had another From tag", () => {
    const { ua } = ringing()
    ua.handle(end(), 100)
    const other = invite({ branch: "z9hG4bKcopy", fromTag: "b2" })
    expect(events(ua.handle(receive(other), 200))).toMatchObject([{ state: "incoming" }])
  })

  it("still refuses the very INVITE of a call that ended as a loop", () => {
    const { ua } = ringing()
    ua.handle(end(), 100)
    const again = ua.handle(receive(invite({ branch: "z9hG4bKcopy" })), 200)
    expect(responses(again)).toMatchObject([{ status: 482 }])
  })

  it("refuses new calls with 503 while too many ended calls linger, and recovers", () => {
    const ua = phone(1)
    for (let index = 0; index < 64; index++) {
      const id = `flood${index}`
      const outputs = ua.handle(receive(invite({ callId: id, branch: `z9hG4bK${id}` })), index)
      expect(events(outputs)).toMatchObject([{ state: "incoming" }])
      ua.handle(end(486, id), index)
    }
    const full = ua.handle(receive(invite({ callId: "late", branch: "z9hG4bKlate" })), 100)
    const [unavailable] = responses(full)
    expect(unavailable).toMatchObject({ status: 503, reason: "Service Unavailable" })
    expect(unavailable && getHeader(unavailable, "Retry-After")).toBe("5")
    run(ua, 100, 40_000)
    const later = ua.handle(receive(invite({ callId: "later", branch: "z9hG4bKlater" })), 40_000)
    expect(events(later)).toMatchObject([{ call: "later", state: "incoming" }])
  })

  it("takes an INVITE with its own From tag but a new CSeq after the outgoing call ended", () => {
    const ua = phone()
    const dial = command({
      type: "call",
      call: "own",
      uri: "sip:alice@example.com",
      to: bob,
      media: local,
    })
    const [own] = requests(ua.handle(dial, 0))
    if (!own) throw new Error("No INVITE")
    ua.handle(reply(own, 486), 10)
    const retry = { ...own, cseq: { seq: 2, method: "INVITE" } }
    const again = { type: "receive", data: serializeMessage(retry), from: bob } as const
    expect(events(ua.handle(again, 20))).toMatchObject([{ call: "own", state: "incoming" }])
  })

  it("knows its own INVITE after the outgoing call ended, but takes a new call on its Call-ID", () => {
    const ua = phone()
    const dial = command({
      type: "call",
      call: "own",
      uri: "sip:alice@example.com",
      to: bob,
      media: local,
    })
    const [own] = requests(ua.handle(dial, 0))
    if (!own) throw new Error("No INVITE")
    ua.handle(reply(own, 486), 10)
    const looped = { type: "receive", data: serializeMessage(own), from: bob } as const
    expect(responses(ua.handle(looped, 20))).toMatchObject([{ status: 482 }])
    const other = invite({ callId: "own", branch: "z9hG4bKother", fromTag: "someone" })
    expect(events(ua.handle(receive(other), 30))).toMatchObject([
      { call: "own", state: "incoming" },
    ])
  })

  it("is busy once maxCalls calls are active, and free again when one ends", () => {
    const ua = phone(1)
    ringing(invite(), ua)
    const busy = ua.handle(receive(invite({ callId: "in2", branch: "z9hG4bKi2" })), 10)
    expect(events(busy)).toMatchObject([{ type: "answered", status: 486 }])
    ua.handle(end(), 20)
    const free = ua.handle(receive(invite({ callId: "in3", branch: "z9hG4bKi3" })), 30)
    expect(events(free)).toMatchObject([{ call: "in3", state: "incoming" }])
  })

  it("counts outgoing calls towards maxCalls", () => {
    const ua = phone(1)
    ua.handle(
      command({ type: "call", call: "out", uri: "sip:bob@example.com", to: bob, media: local }),
      0,
    )
    expect(events(ua.handle(receive(invite()), 10))).toMatchObject([
      { type: "answered", status: 486 },
    ])
  })

  it("rejects every INVITE when maxCalls is 0", () => {
    expect(responses(phone(0).handle(receive(invite()), 0))).toMatchObject([{ status: 486 }])
  })

  it("answers an INVITE for a dialog it does not know with 481 statelessly (§12.2.2)", () => {
    const outputs = phone().handle(receive(invite({ toTag: "gone" })), 0)
    expect(events(outputs)).toMatchObject([{ type: "answered", status: 481 }])
    expect(responses(outputs)).toMatchObject([{ status: 481 }])
  })

  it("lets an ACK for a rejected Call-ID it knows pass quietly", () => {
    const { ua } = ringing()
    const [loop] = responses(
      ua.handle(receive(invite({ branch: "z9hG4bKother", fromTag: "b9" })), 10),
    )
    const tag = loop?.to.params.get("tag") ?? ""
    const ack = request("ACK", { toTag: tag, fromTag: "b9", branch: "z9hG4bKother" })
    expect(ua.handle(receive(ack), 20)).toStrictEqual([])
  })

  it.each([-1, 1.5, 70_000, Number.NaN])("rejects maxCalls %s", (maxCalls) => {
    expect(() => phone(maxCalls)).toThrow(RangeError)
    expect(() => phone(maxCalls)).toThrow(/^maxCalls must be an integer from 0 to 65535, got /)
  })
})

describe("in-dialog requests on a live call", () => {
  it("answers a session refresh with 200 and its own SDP but reports nothing new", () => {
    const { ua, ourTag } = acked()
    const outputs = ua.handle(receive(invite({ toTag: ourTag, seq: 2, branch: "z9hG4bKr2" })), 5000)
    const [ok] = responses(outputs)
    expect(ok).toMatchObject({ status: 200, cseq: { seq: 2, method: "INVITE" } })
    expect(text(ok?.body)).toContain("m=audio 40000 RTP/AVP 0\r\n")
    expect(ok?.contact).toHaveLength(1)
    expect(ok && getHeaders(ok, "Record-Route")).toStrictEqual([])
    expect(calls(outputs)).toStrictEqual([])
  })

  it("answers hold with recvonly and reports it (RFC 3264 §8.4)", () => {
    const { ua, ourTag } = acked()
    const outputs = ua.handle(
      receive(invite({ toTag: ourTag, seq: 2, branch: "z9hG4bKr2", body: hold })),
      5000,
    )
    expect(text(responses(outputs)[0]?.body)).toContain("a=recvonly\r\n")
    expect(calls(outputs)).toStrictEqual([
      { type: "call", call: "in1", state: "live", media: { ...negotiated, direction: "recvonly" } },
    ])
  })

  it("keeps the session when a re-offer has nothing it can play", () => {
    const { ua, ourTag } = acked()
    const g729 = sdp({ formats: [18], version: 2 })
    const outputs = ua.handle(
      receive(invite({ toTag: ourTag, seq: 2, branch: "z9hG4bKr2", body: g729 })),
      5000,
    )
    expect(responses(outputs)).toMatchObject([{ status: 488, reason: "Not Acceptable Here" }])
    expect(calls(outputs)).toStrictEqual([])
    const ack = request("ACK", { toTag: ourTag, seq: 2, branch: "z9hG4bKr2" })
    ua.handle(receive(ack), 5100)
    expect(run(ua, 5100, 50_000)).toStrictEqual([])
    const refresh = invite({ toTag: ourTag, seq: 3, branch: "z9hG4bKr3" })
    expect(statuses(ua.handle(receive(refresh), 60_000))).toStrictEqual(["200 INVITE"])
  })

  it("sends its BYE to the Contact of a re-INVITE it accepted (§12.2.2)", () => {
    const { ua, ourTag } = acked()
    const moved = invite({ toTag: ourTag, seq: 2, branch: "z9hG4bKr2" }).replace(
      "sip:bob@192.0.2.20:5070",
      "sip:bob@198.51.100.7:6000",
    )
    ua.handle(receive(moved), 5000)
    ua.handle(receive(request("ACK", { toTag: ourTag, seq: 2, branch: "z9hG4bKa2" })), 5100)
    const [bye] = requests(ua.handle(end(), 5200))
    expect(bye?.uri).toBe("sip:bob@198.51.100.7:6000")
  })

  it("ignores an SDP in the ACK when its 200 carried no offer", () => {
    const { ua, ourTag } = answered()
    const ack = request("ACK", { toTag: ourTag, body: hold })
    expect(calls(ua.handle(receive(ack), 1100))).toStrictEqual([
      { type: "call", call: "in1", state: "live", media: negotiated },
    ])
  })

  it("resends the 200 for a re-INVITE until its ACK and asks overlapping ones to retry", () => {
    const { ua, ourTag } = acked()
    ua.handle(receive(invite({ toTag: ourTag, seq: 2, branch: "z9hG4bKr2" })), 5000)
    expect(statuses(ua.handle(timeout, 5500))).toStrictEqual(["200 INVITE"])
    const overlap = ua.handle(receive(invite({ toTag: ourTag, seq: 3, branch: "z9hG4bKr3" })), 5600)
    expect(responses(overlap)).toMatchObject([{ status: 500 }])
    expect(
      responses(overlap)[0] && getHeader(responses(overlap)[0] as SipResponse, "Retry-After"),
    ).toMatch(/^\d+$/)
    ua.handle(receive(request("ACK", { toTag: ourTag, seq: 3, branch: "z9hG4bKr3" })), 5650)
    ua.handle(receive(request("ACK", { toTag: ourTag, seq: 2, branch: "z9hG4bKa2" })), 5700)
    expect(run(ua, 5700, 50_000)).toStrictEqual([])
  })

  it("hangs up when the 200 for a re-INVITE is never acknowledged (§14.2)", () => {
    const { ua, ourTag } = acked()
    ua.handle(receive(invite({ toTag: ourTag, seq: 2, branch: "z9hG4bKr2" })), 5000)
    const steps = run(ua, 5000, 37_000)
    expect(steps.at(-1)?.[0]).toBe(37_000)
    expect(requests(steps.at(-1)?.[1] ?? []).map((r) => r.method)).toStrictEqual(["BYE"])
  })

  it("takes the answer from the ACK when a re-INVITE carries no offer", () => {
    const { ua, ourTag } = acked()
    const outputs = ua.handle(
      receive(invite({ toTag: ourTag, seq: 2, branch: "z9hG4bKr2", body: null })),
      5000,
    )
    expect(text(responses(outputs)[0]?.body)).toContain("m=audio 40000 RTP/AVP 0 8\r\n")
    const ack = ua.handle(receive(request("ACK", { toTag: ourTag, seq: 2, body: hold })), 5100)
    expect(calls(ack)).toStrictEqual([
      { type: "call", call: "in1", state: "live", media: { ...negotiated, direction: "recvonly" } },
    ])
  })

  it("stops resending the 200 for a re-INVITE once the caller hangs up", () => {
    const { ua, ourTag } = acked()
    ua.handle(receive(invite({ toTag: ourTag, seq: 2, branch: "z9hG4bKr2" })), 5000)
    ua.handle(receive(request("BYE", { toTag: ourTag, seq: 3 })), 5100)
    expect(run(ua, 5100, 50_000)).toStrictEqual([])
  })

  it("accepts a BYE that reuses the CSeq of the INVITE, which is not out of order", () => {
    const { ua, ourTag } = acked()
    expect(
      statuses(ua.handle(receive(request("BYE", { toTag: ourTag, seq: 1 })), 2000)),
    ).toStrictEqual(["200 BYE"])
  })

  it("refuses a BYE below the CSeq of the INVITE", () => {
    const { ua, ourTag } = ringing(invite({ seq: 5 }))
    ua.handle(accept(), 1000)
    ua.handle(receive(request("ACK", { toTag: ourTag, seq: 5 })), 1100)
    expect(
      statuses(ua.handle(receive(request("BYE", { toTag: ourTag, seq: 3 })), 2000)),
    ).toStrictEqual(["500 BYE"])
  })

  it("reports nothing when the ACK repeats the media it already had", () => {
    const { ua, ourTag } = acked()
    ua.handle(receive(invite({ toTag: ourTag, seq: 2, branch: "z9hG4bKr2", body: null })), 5000)
    const repeat = request("ACK", { toTag: ourTag, seq: 2, body: remote, branch: "z9hG4bKa2" })
    expect(ua.handle(receive(repeat), 5100)).toStrictEqual([])
  })

  it("keeps its media when the ACK to a re-INVITE carries no usable answer", () => {
    const { ua, ourTag } = acked()
    ua.handle(receive(invite({ toTag: ourTag, seq: 2, branch: "z9hG4bKr2", body: null })), 5000)
    expect(ua.handle(receive(request("ACK", { toTag: ourTag, seq: 2 })), 5100)).toStrictEqual([])
    expect(run(ua, 5100, 50_000)).toStrictEqual([])
  })

  it("hangs up a late-offer call whose ACK brings nothing it can play", () => {
    const { ua, ourTag } = ringing(invite({ body: null }))
    ua.handle(accept(), 1000)
    const ack = request("ACK", { toTag: ourTag, body: sdp({ formats: [18] }) })
    const [bye] = requests(ua.handle(receive(ack), 1100))
    expect(bye?.method).toBe("BYE")
    expect(bye && getHeader(bye, "Reason")).toBe('SIP;cause=488;text="Incompatible media"')
    if (!bye) throw new Error("No BYE")
    expect(calls(ua.handle(reply(bye, 200), 1200))).toStrictEqual([
      { type: "call", call: "in1", state: "ended", ended: { by: "local", reason: "incompatible" } },
    ])
  })

  it("hangs up a late-offer call whose ACK brings no answer at all", () => {
    const { ua, ourTag } = ringing(invite({ body: null }))
    ua.handle(accept(), 1000)
    const [bye] = requests(ua.handle(receive(request("ACK", { toTag: ourTag })), 1100))
    expect(bye?.method).toBe("BYE")
  })

  it("refuses a re-INVITE that requires an extension", () => {
    const { ua, ourTag } = acked()
    const text = invite({ toTag: ourTag, seq: 2, branch: "z9hG4bKr2", extra: ["Require: timer"] })
    expect(responses(ua.handle(receive(text), 5000))).toMatchObject([
      { status: 420, headers: expect.arrayContaining([{ name: "Unsupported", value: "timer" }]) },
    ])
  })

  it("refuses requests below the last remote CSeq with 500 (§12.2.2)", () => {
    const { ua, ourTag } = acked()
    ua.handle(receive(invite({ toTag: ourTag, seq: 5, branch: "z9hG4bKr5" })), 5000)
    ua.handle(receive(request("ACK", { toTag: ourTag, seq: 5 })), 5100)
    const old = ua.handle(receive(request("BYE", { toTag: ourTag, seq: 4 })), 5200)
    expect(responses(old)).toMatchObject([{ status: 500 }])
    expect(
      responses(old)[0] && getHeader(responses(old)[0] as SipResponse, "Retry-After"),
    ).toBeUndefined()
    expect(calls(old)).toStrictEqual([])
    const bye = ua.handle(
      receive(request("BYE", { toTag: ourTag, seq: 6, branch: "z9hG4bKb6" })),
      5300,
    )
    expect(statuses(bye)).toStrictEqual(["200 BYE"])
  })

  it("refuses a re-INVITE with 481 once it is hanging up", () => {
    const { ua, ourTag } = acked()
    ua.handle(end(), 2000)
    const outputs = ua.handle(receive(invite({ toTag: ourTag, seq: 2, branch: "z9hG4bKr2" })), 2050)
    expect(responses(outputs)).toMatchObject([{ status: 481 }])
  })

  it("counts a BYE that crosses its own as the end it asked for", () => {
    const { ua, ourTag } = acked()
    ua.handle(end(), 2000)
    const outputs = ua.handle(receive(request("BYE", { toTag: ourTag, seq: 2 })), 2050)
    expect(statuses(outputs)).toStrictEqual(["200 BYE"])
    expect(calls(outputs)).toMatchObject([{ ended: { by: "local", reason: "hangup" } }])
  })
})

describe("validating the answer and end commands", () => {
  it.each([
    [{ type: "accept", call: "a b", media: local }, TypeError],
    [{ type: "accept", call: "in1", media: "v=0" as never }, TypeError],
    [{ type: "accept", call: "in1", media: { host: "0.0.0.0", port: 4000 } }, TypeError],
    [{ type: "end", call: "in1", status: 399 }, RangeError],
    [{ type: "end", call: "in1", status: 700 }, RangeError],
    [{ type: "end", call: "in1", status: 486.5 }, RangeError],
    [{ type: "accept", call: "in1", media: { host: "192.0.2.10", port: 0 } }, RangeError],
  ] as const)("rejects %o", (value, error) => {
    const { ua } = ringing()
    expect(() => ua.handle(command(value as CoreCommand), 10)).toThrow(error)
  })

  it("accepts the Call-ID of any call it was offered", () => {
    const callId = "a;b=c@[::1]"
    const { ua } = ringing(invite({ callId }))
    expect(responses(ua.handle(accept(callId), 10))).toMatchObject([{ status: 200, callId }])
  })

  it("ignores answering an outgoing call", () => {
    const ua = phone()
    ua.handle(
      command({ type: "call", call: "out", uri: "sip:bob@example.com", to: bob, media: local }),
      0,
    )
    expect(ua.handle(accept("out"), 10)).toStrictEqual([])
  })
})
