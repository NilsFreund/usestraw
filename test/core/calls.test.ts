import { describe, expect, it } from "vitest"
import {
  type CoreEvent,
  type CoreOutput,
  createCore,
  getHeader,
  isRequest,
  parseMessage,
  type SipRequest,
  serializeMessage,
} from "../../src/core"
import { reasonFor } from "../../src/core/calls/reasons"
import { createRandom } from "../../src/simulation/random"
import { alice, aliceMedia, bob, bytes, sdp } from "../helpers"

const answer = sdp({ formats: [0, 101] })
const media = aliceMedia
const negotiated = {
  remote: { host: "192.0.2.20", port: 4000 },
  codec: "PCMU",
  payloadType: 0,
  ptime: 20,
  direction: "sendrecv",
} as const

const call = (id = "c1") =>
  ({
    type: "command",
    command: { type: "call", call: id, uri: "sip:bob@example.com", to: bob, media },
  }) as const
const end = (id = "c1") => ({ type: "command", command: { type: "end", call: id } }) as const
const receive = (text: string) => ({ type: "receive", data: bytes(text), from: bob }) as const

function phone() {
  return createCore({ address: alice, aor: "sip:alice@example.com", random: createRandom(1) })
}

function sentRequests(outputs: CoreOutput[]): SipRequest[] {
  return outputs.flatMap((output) => {
    if (output.type !== "send") return []
    const parsed = parseMessage(output.data)
    return parsed.ok && isRequest(parsed.message) ? [parsed.message] : []
  })
}

function sentResponses(outputs: CoreOutput[]): number[] {
  return outputs.flatMap((output) => {
    if (output.type !== "send") return []
    const parsed = parseMessage(output.data)
    return parsed.ok && !isRequest(parsed.message) ? [parsed.message.status] : []
  })
}

const events = (outputs: CoreOutput[]): CoreEvent[] =>
  outputs.flatMap((output) => (output.type === "event" ? [output.event] : []))

function reply(
  invite: SipRequest,
  status: number,
  extra: string[] = [],
  tag = "t2",
  contact: string | null = "<sip:bob@192.0.2.20:5060>",
  body = invite.method === "INVITE" && status >= 200 && status < 300 ? answer : "",
): string {
  const head = new TextDecoder().decode(serializeMessage(invite)).split("\r\n")
  const lines = head.filter((line) => /^(Via|From|Call-ID|CSeq):/.test(line))
  return [
    `SIP/2.0 ${status} Answer`,
    ...lines,
    `To: <sip:bob@example.com>;tag=${tag}`,
    ...(contact === null ? [] : [`Contact: ${contact}`]),
    ...extra,
    ...(body === "" ? [] : ["Content-Type: application/sdp"]),
    `Content-Length: ${body.length}`,
    "",
    body,
  ].join("\r\n")
}

function inDialog(method: string, seq: number, ourTag: string, branch = "z9hG4bKin1"): string {
  return [
    `${method} sip:alice@192.0.2.10:5060 SIP/2.0`,
    `Via: SIP/2.0/UDP 192.0.2.20:5060;branch=${branch}`,
    "From: <sip:bob@example.com>;tag=t2",
    `To: <sip:alice@example.com>;tag=${ourTag}`,
    "Call-ID: c1",
    `CSeq: ${seq} ${method}`,
    "Content-Length: 0",
    "",
    "",
  ].join("\r\n")
}

function live() {
  const ua = phone()
  const [invite] = sentRequests(ua.handle(call(), 0))
  if (!invite) throw new Error("No INVITE")
  const outputs = ua.handle(receive(reply(invite, 200)), 10)
  const ourTag = invite.from.params.get("tag") ?? ""
  return { ua, invite, outputs, ourTag }
}

describe("calls in the core", () => {
  it("checks a call before it starts one", () => {
    const ua = phone()
    expect(() =>
      ua.handle(
        {
          type: "command",
          command: { type: "call", call: "a b", uri: "sip:b@x", to: bob, media },
        },
        0,
      ),
    ).toThrow("Invalid Call-ID")
    expect(() =>
      ua.handle(
        {
          type: "command",
          command: { type: "call", call: "c1", uri: "bad uri", to: bob, media },
        },
        0,
      ),
    ).toThrow("Invalid Request-URI")
    expect(() =>
      ua.handle(
        {
          type: "command",
          command: {
            type: "call",
            call: "c1",
            uri: "sip:b@x",
            to: { ...bob, port: 70_000 },
            media,
          },
        },
        0,
      ),
    ).toThrow("Invalid address")
    const wrongs: [unknown, Error][] = [
      ["v=0", new TypeError('Invalid media "v=0"')],
      [null, new TypeError("Invalid media null")],
      ...["0.0.0.0", "000.0.0.0", "::", "[::]", "::0", "224.0.0.1", "255.255.255.255", "ff02::1"]
        .concat(["media.example.com", "a b", "fe80::1%en0", "192.0.2.256"])
        .map((host): [unknown, Error] => [
          { host, port: 4000 },
          new TypeError(
            `The media host must be an IP address the far end can reach, got "${host}"`,
          ),
        ]),
      [
        { host: 42, port: 4000 },
        new TypeError("The media host must be an IP address the far end can reach, got 42"),
      ],
      [
        { host: "192.0.2.10", port: Number.NaN },
        new RangeError("The media port must be an even number from 2 to 65534, got null"),
      ],
      ...[0, 4001, 65_536, 4000.5].map((port): [unknown, Error] => [
        { host: "192.0.2.10", port },
        new RangeError(`The media port must be an even number from 2 to 65534, got ${port}`),
      ]),
    ]
    for (const [wrong, error] of wrongs) {
      const command = { type: "call", call: "c1", uri: "sip:b@x", to: bob, media: wrong } as never
      expect(() => ua.handle({ type: "command", command }, 0)).toThrow(error)
    }
    ua.handle(call(), 0)
    expect(() => ua.handle(call(), 0)).toThrow('Call "c1" already exists')
    expect(() => ua.handle({ type: "command", command: { type: "end", call: "a b" } }, 0)).toThrow(
      'Invalid call "a b"',
    )
    expect(ua.handle(end("unknown"), 0)).toStrictEqual([])
  })

  it("answers the BYE that ends the dialog with 200 and every later one with 481", () => {
    const { ua, ourTag } = live()
    const bye = ua.handle(receive(inDialog("BYE", 6, ourTag, "z9hG4bKb1")), 20)
    expect(sentResponses(bye)).toStrictEqual([200])
    expect(events(bye)).toContainEqual({
      type: "call",
      call: "c1",
      state: "ended",
      ended: { by: "remote", reason: "hangup" },
    })
    expect(
      sentResponses(ua.handle(receive(inDialog("BYE", 6, ourTag, "z9hG4bKb1")), 25)),
    ).toStrictEqual([200])
    const later = ua.handle(receive(inDialog("BYE", 7, ourTag, "z9hG4bKb2")), 30)
    expect(sentResponses(later)).toStrictEqual([481])
    expect(events(later).filter((event) => event.type === "call")).toStrictEqual([])
  })

  it("answers other requests in the dialog once and statelessly", () => {
    const { ua, ourTag } = live()
    const before = ua.nextDeadline()
    expect(sentResponses(ua.handle(receive(inDialog("INFO", 5, ourTag)), 20))).toStrictEqual([405])
    expect(sentResponses(ua.handle(receive(inDialog("MESSAGE", 6, ourTag)), 30))).toStrictEqual([
      405,
    ])
    expect(ua.nextDeadline()).toBe(before)
  })

  it("leaves requests with our Call-ID but another dialog to the stateless answers", () => {
    const { ua } = live()
    expect(sentResponses(ua.handle(receive(inDialog("BYE", 9, "someone-else")), 20))).toStrictEqual(
      [481],
    )
  })

  it("ends after its BYE goes unanswered", () => {
    const { ua } = live()
    const [bye] = sentRequests(ua.handle(end(), 100))
    expect(bye?.method).toBe("BYE")
    let outputs: CoreOutput[] = []
    for (let now = 100; now <= 40_000; now += 500)
      outputs = [...outputs, ...ua.handle({ type: "timeout" }, now)]
    expect(events(outputs)).toContainEqual({
      type: "call",
      call: "c1",
      state: "ended",
      ended: { by: "local", reason: "hangup" },
    })
    expect(ua.handle(end(), 41_000)).toStrictEqual([])
  })

  it("forgets ended calls after 64·T1 and then treats their messages as stray", () => {
    const ua = phone()
    const first = sentRequests(ua.handle(call("c1"), 0))[0]
    const second = sentRequests(ua.handle(call("c2"), 1000))[0]
    if (!first || !second) throw new Error("No INVITE")
    ua.handle(receive(reply(first, 486)), 10)
    ua.handle(receive(reply(second, 486)), 1010)
    expect(ua.nextDeadline()).toBeLessThanOrEqual(32_010)
    ua.handle({ type: "timeout" }, 32_010)
    ua.handle({ type: "timeout" }, 33_010)
    expect(ua.nextDeadline()).toBeUndefined()
    const late = ua.handle(receive(reply(first, 200)), 40_000)
    expect(events(late)).toMatchObject([{ type: "stray" }])
  })

  it("drops a Record-Route it cannot read", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    const answer = reply(invite, 200, [
      "Record-Route: <sip:edge.example.com;lr>",
      "Record-Route: <<broken",
    ])
    ua.handle(receive(answer), 10)
    const [bye] = sentRequests(ua.handle(end(), 20))
    expect(bye?.headers.filter((header) => header.name === "Route")).toStrictEqual([
      { name: "Route", value: "<sip:edge.example.com;lr>" },
    ])
  })
})

describe("re-INVITEs on an outgoing call (RFC 3261 §14.2)", () => {
  const reinvite = (ourTag: string, seq: number, body = "") =>
    inDialog("INVITE", seq, ourTag, `z9hG4bKre${seq}`).replace(
      "Content-Length: 0\r\n\r\n",
      body === ""
        ? "Content-Length: 0\r\n\r\n"
        : `Content-Type: application/sdp\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    )

  const responses = (outputs: CoreOutput[]) =>
    outputs.flatMap((output) => {
      if (output.type !== "send") return []
      const parsed = parseMessage(output.data)
      return parsed.ok && !isRequest(parsed.message) ? [parsed.message] : []
    })

  const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data)
  const withBody = (request: string, body: string) =>
    request.replace(
      "Content-Length: 0\r\n\r\n",
      `Content-Type: application/sdp\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    )

  it("offers its SDP to an offerless re-INVITE and takes the answer from the ACK", () => {
    const { ua, ourTag } = live()
    const refresh = ua.handle(receive(reinvite(ourTag, 1)), 20)
    const [ok] = responses(refresh)
    expect(ok?.status).toBe(200)
    expect(text(ok?.body)).toContain("m=audio 40000 RTP/AVP 0 8\r\n")
    expect(text(ok?.body)).toContain("a=sendrecv\r\n")
    expect(ok?.to.params.get("tag")).toBe(ourTag)
    expect(events(refresh)).toStrictEqual([])
    const ack = withBody(
      inDialog("ACK", 1, ourTag, "z9hG4bKack1"),
      sdp({ formats: [8], port: 5000 }),
    )
    expect(events(ua.handle(receive(ack), 30))).toStrictEqual([
      {
        type: "call",
        call: "c1",
        state: "live",
        media: {
          remote: { host: "192.0.2.20", port: 5000 },
          codec: "PCMA",
          payloadType: 8,
          ptime: 20,
          direction: "sendrecv",
        },
      },
    ])
  })

  it("keeps its media when the ACK to its offer brings no answer it can use", () => {
    const { ua, ourTag } = live()
    ua.handle(receive(reinvite(ourTag, 1)), 20)
    expect(ua.handle(receive(inDialog("ACK", 1, ourTag, "z9hG4bKack1")), 30)).toStrictEqual([])
    ua.handle(receive(reinvite(ourTag, 2)), 40)
    const g729 = withBody(inDialog("ACK", 2, ourTag, "z9hG4bKack2"), sdp({ formats: [18] }))
    expect(ua.handle(receive(g729), 50)).toStrictEqual([])
    expect(sentRequests(ua.handle(end(), 60)).map((request) => request.method)).toStrictEqual([
      "BYE",
    ])
  })

  it("answers hold with recvonly and taking it off hold with sendrecv (RFC 3264 §8.4)", () => {
    const { ua, ourTag } = live()
    const hold = ua.handle(
      receive(reinvite(ourTag, 1, sdp({ formats: [0, 101], direction: "sendonly", version: 2 }))),
      20,
    )
    const [held] = responses(hold)
    expect(text(held?.body)).toContain("a=recvonly\r\n")
    expect(events(hold)).toStrictEqual([
      { type: "call", call: "c1", state: "live", media: { ...negotiated, direction: "recvonly" } },
    ])
    ua.handle(receive(inDialog("ACK", 1, ourTag, "z9hG4bKack1")), 30)
    const resume = ua.handle(
      receive(reinvite(ourTag, 2, sdp({ formats: [0, 101], version: 3 }))),
      40,
    )
    expect(text(responses(resume)[0]?.body)).toContain("a=sendrecv\r\n")
    expect(events(resume)).toStrictEqual([
      { type: "call", call: "c1", state: "live", media: negotiated },
    ])
  })

  it("follows media that moves to a new address and keeps its codec", () => {
    const { ua, ourTag } = live()
    const moved = sdp({ host: "198.51.100.7", port: 6000, formats: [8, 0, 101], version: 2 })
    const outputs = ua.handle(receive(reinvite(ourTag, 1, moved)), 20)
    expect(text(responses(outputs)[0]?.body)).toContain("m=audio 40000 RTP/AVP 0\r\n")
    expect(events(outputs)).toStrictEqual([
      {
        type: "call",
        call: "c1",
        state: "live",
        media: { ...negotiated, remote: { host: "198.51.100.7", port: 6000 } },
      },
    ])
  })

  it("answers a refresh with the very same SDP and reports nothing", () => {
    const { ua, ourTag } = live()
    const first = responses(ua.handle(receive(reinvite(ourTag, 1, answer)), 20))[0]
    ua.handle(receive(inDialog("ACK", 1, ourTag, "z9hG4bKack1")), 30)
    const again = ua.handle(receive(reinvite(ourTag, 2, answer)), 40)
    expect(responses(again)[0]?.body).toStrictEqual(first?.body)
    expect(events(again)).toStrictEqual([])
    expect(sentResponses(ua.handle({ type: "timeout" }, 540))).toStrictEqual([200])
  })

  it("keeps the session and the remote target when a re-offer has nothing it can play", () => {
    const { ua, ourTag } = live()
    const moved = withBody(reinvite(ourTag, 1), sdp({ formats: [18] })).replace(
      "CSeq:",
      "Contact: <sip:bob@198.51.100.7:5070>\r\nCSeq:",
    )
    const outputs = ua.handle(receive(moved), 20)
    expect(sentResponses(outputs)).toStrictEqual([488])
    const [refusal] = outputs.flatMap((output) => {
      if (output.type !== "send") return []
      const parsed = parseMessage(output.data)
      return parsed.ok && !isRequest(parsed.message) ? [parsed.message] : []
    })
    expect(refusal && getHeader(refusal, "Warning")).toBe('305 straw "Incompatible media format"')
    expect(events(outputs)).toStrictEqual([])
    const [bye] = sentRequests(ua.handle(end(), 40))
    expect(bye?.uri).toBe("sip:bob@192.0.2.20:5060")
  })

  it("sends its BYE to the Contact of a re-INVITE it accepted (§12.2.2)", () => {
    const { ua, ourTag } = live()
    const moved = reinvite(ourTag, 1).replace(
      "CSeq:",
      "Contact: <sip:bob@198.51.100.7:5070>\r\nCSeq:",
    )
    ua.handle(receive(moved), 20)
    ua.handle(receive(withBody(inDialog("ACK", 1, ourTag, "z9hG4bKack1"), answer)), 30)
    const [bye] = sentRequests(ua.handle(end(), 40))
    expect(bye?.uri).toBe("sip:bob@198.51.100.7:5070")
  })

  it("hangs up at once while the 200 to a re-INVITE still waits for its ACK", () => {
    const { ua, ourTag } = live()
    ua.handle(receive(reinvite(ourTag, 1)), 20)
    const outputs = ua.handle(end(), 30)
    expect(sentRequests(outputs).map((request) => request.method)).toStrictEqual(["BYE"])
    const later = []
    for (let now = 500; now <= 40_000; now += 500)
      later.push(...ua.handle({ type: "timeout" }, now))
    expect(responses(later)).toStrictEqual([])
  })

  it("ends when the answer to its BYE carries a To tag it did not expect", () => {
    const { ua } = live()
    const [bye] = sentRequests(ua.handle(end(), 20))
    if (!bye) throw new Error("No BYE")
    const odd = reply(bye, 200, [], "unexpected")
    expect(events(ua.handle(receive(odd), 30))).toStrictEqual([
      { type: "call", call: "c1", state: "ended", ended: { by: "local", reason: "hangup" } },
    ])
  })

  it("accepts any first CSeq from the callee and refuses older ones after it", () => {
    const { ua, ourTag } = live()
    expect(sentResponses(ua.handle(receive(reinvite(ourTag, 900)), 20))).toStrictEqual([200])
    ua.handle(receive(inDialog("ACK", 900, ourTag, "z9hG4bKack900")), 30)
    expect(sentResponses(ua.handle(receive(reinvite(ourTag, 899)), 40))).toStrictEqual([500])
  })

  it("answers a CANCEL for an answered re-INVITE with 200 and keeps the call", () => {
    const { ua, ourTag } = live()
    ua.handle(receive(reinvite(ourTag, 1)), 20)
    const cancel = inDialog("CANCEL", 1, ourTag, "z9hG4bKre1")
    const outputs = ua.handle(receive(cancel), 30)
    expect(sentResponses(outputs)).toStrictEqual([200])
    expect(events(outputs)).toStrictEqual([])
  })

  it("answers a CANCEL for a re-INVITE of an ended call with 200", () => {
    const { ua, ourTag } = live()
    ua.handle(receive(reinvite(ourTag, 1)), 20)
    ua.handle(receive(inDialog("BYE", 2, ourTag, "z9hG4bKbye2")), 25)
    const outputs = ua.handle(receive(inDialog("CANCEL", 1, ourTag, "z9hG4bKre1")), 30)
    expect(sentResponses(outputs)).toStrictEqual([200])
  })
})

describe("calls when the far end misbehaves", () => {
  it("counts an INVITE as cancelled when its CANCEL is never answered", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    ua.handle(receive(reply(invite, 180)), 10)
    expect(sentRequests(ua.handle(end(), 20)).map((request) => request.method)).toStrictEqual([
      "CANCEL",
    ])
    const outputs: CoreOutput[] = []
    for (let now = 520; now <= 40_000; now += 500)
      outputs.push(...ua.handle({ type: "timeout" }, now))
    expect(events(outputs)).toContainEqual({
      type: "call",
      call: "c1",
      state: "ended",
      ended: { by: "local", reason: "cancelled" },
    })
    expect(sentRequests(ua.handle(receive(reply(invite, 487)), 40_050))).toStrictEqual([])
    const late = ua.handle(receive(reply(invite, 200)), 40_100)
    expect(sentRequests(late).map((request) => request.method)).toStrictEqual(["ACK", "BYE"])
  })

  it("swallows an ACK inside the dialog that acknowledges nothing", () => {
    const { ua, ourTag } = live()
    expect(ua.handle(receive(inDialog("ACK", 1, ourTag)), 20)).toStrictEqual([])
  })

  it("does not take the answer or the timeout of a fork's BYE for its own", () => {
    const answered = live()
    const [, forkBye] = sentRequests(
      answered.ua.handle(receive(reply(answered.invite, 200, [], "t3")), 20),
    )
    const [bye] = sentRequests(answered.ua.handle(end(), 30))
    if (!forkBye || !bye) throw new Error("No BYE")
    expect(answered.ua.handle(receive(reply(forkBye, 200, [], "t3")), 40)).toStrictEqual([])
    expect(events(answered.ua.handle(receive(reply(bye, 200)), 50))).toMatchObject([
      { state: "ended" },
    ])
    const silent = live()
    silent.ua.handle(receive(reply(silent.invite, 200, [], "t3")), 20)
    silent.ua.handle(end(), 1000)
    const ends: number[] = []
    for (let now = 500; now <= 40_000; now += 500) {
      if (events(silent.ua.handle({ type: "timeout" }, now)).length > 0) ends.push(now)
    }
    expect(ends).toStrictEqual([33_000])
  })

  it("stays live when the BYE to an extra fork goes unanswered", () => {
    const { ua, invite } = live()
    const fork = sentRequests(ua.handle(receive(reply(invite, 200, [], "t3")), 20))
    expect(fork.map((request) => request.method)).toStrictEqual(["ACK", "BYE"])
    const outputs: CoreOutput[] = []
    for (let now = 520; now <= 40_000; now += 500)
      outputs.push(...ua.handle({ type: "timeout" }, now))
    expect(events(outputs).filter((event) => event.type === "call")).toStrictEqual([])
    expect(sentRequests(ua.handle(end(), 40_100)).map((request) => request.method)).toStrictEqual([
      "BYE",
    ])
  })

  it.each([
    ["no Contact", null],
    ["a star Contact", "*"],
  ])("sends its BYE to the original target after a 200 with %s", (_, contact) => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    ua.handle(receive(reply(invite, 200, [], "t2", contact)), 10)
    const [bye] = sentRequests(ua.handle(end(), 20))
    expect(bye?.uri).toBe("sip:bob@example.com")
  })
})

describe("calls in rarer situations", () => {
  it("treats requests for a call without a dialog yet as strangers", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    const ourTag = invite?.from.params.get("tag") ?? ""
    expect(sentResponses(ua.handle(receive(inDialog("BYE", 2, ourTag)), 10))).toStrictEqual([481])
    expect(ua.handle(receive(inDialog("ACK", 1, ourTag)), 20)).toStrictEqual([])
  })

  it("ignores a status when it ends an outgoing call", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    ua.handle(receive(reply(invite, 180)), 10)
    const ending = { type: "command", command: { type: "end", call: "c1", status: 603 } } as const
    expect(sentRequests(ua.handle(ending, 20)).map((request) => request.method)).toStrictEqual([
      "CANCEL",
    ])
  })

  it("ignores ending a call that was already rejected", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    ua.handle(receive(reply(invite, 486)), 10)
    expect(ua.handle(end(), 20)).toStrictEqual([])
  })

  it("reports early media with the ringing state", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    const early = reply(invite, 183, [], "t2", null, sdp({ port: 5004 }))
    expect(events(ua.handle(receive(early), 10))).toStrictEqual([
      {
        type: "call",
        call: "c1",
        state: "ringing",
        status: 183,
        media: { ...negotiated, remote: { ...negotiated.remote, port: 5004 } },
      },
    ])
    const unusable = reply(invite, 183, [], "t3", null, sdp({ formats: [18] }))
    expect(events(ua.handle(receive(unusable), 20))).toStrictEqual([
      { type: "call", call: "c1", state: "ringing", status: 183 },
    ])
  })

  it("keeps the early media when the 200 carries no answer, and hangs up without either", () => {
    const early = phone()
    const [invite] = sentRequests(early.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    early.handle(receive(reply(invite, 183, [], "t2", null, sdp({ port: 5004 }))), 10)
    expect(
      events(early.handle(receive(reply(invite, 200, [], "t2", undefined, "")), 20)),
    ).toStrictEqual([
      {
        type: "call",
        call: "c1",
        state: "live",
        media: { ...negotiated, remote: { ...negotiated.remote, port: 5004 } },
      },
    ])
    const silent = phone()
    const [other] = sentRequests(silent.handle(call(), 0))
    if (!other) throw new Error("No INVITE")
    const outputs = silent.handle(receive(reply(other, 200, [], "t2", undefined, "")), 20)
    expect(sentRequests(outputs).map((request) => request.method)).toStrictEqual(["ACK", "BYE"])
    expect(events(outputs)).toStrictEqual([])
  })

  it("keeps tagless early media for a tagless 200 without an answer from an old far end", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    const untagged = (text: string) => text.replace(";tag=t2", "")
    ua.handle(receive(untagged(reply(invite, 183, [], "t2", null, sdp({ port: 5004 })))), 10)
    const outputs = ua.handle(receive(untagged(reply(invite, 200, [], "t2", undefined, ""))), 20)
    expect(events(outputs)).toMatchObject([{ state: "live", media: { remote: { port: 5004 } } }])
  })

  it("never takes another fork's early media for a 200 without an answer", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    ua.handle(
      receive(reply(invite, 183, [], "a", null, sdp({ host: "198.51.100.66", port: 6666 }))),
      10,
    )
    const outputs = ua.handle(receive(reply(invite, 200, [], "b", undefined, "")), 20)
    expect(sentRequests(outputs).map((request) => request.method)).toStrictEqual(["ACK", "BYE"])
    expect(events(outputs)).toStrictEqual([])
  })

  it("remembers early media from at most 16 forks", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    for (let fork = 0; fork <= 16; fork++) {
      const early = reply(invite, 183, [], `f${fork}`, null, sdp({ port: 5000 + 2 * fork }))
      ua.handle(receive(early), 10 + fork)
    }
    const known = phone()
    const [other] = sentRequests(known.handle(call(), 0))
    if (!other) throw new Error("No INVITE")
    for (let fork = 0; fork <= 16; fork++) {
      known.handle(
        receive(reply(other, 183, [], `f${fork}`, null, sdp({ port: 5000 + 2 * fork }))),
        10,
      )
    }
    known.handle(receive(reply(other, 183, [], "f3", null, sdp({ port: 7000 }))), 30)
    expect(
      events(known.handle(receive(reply(other, 200, [], "f3", undefined, "")), 40)),
    ).toMatchObject([{ state: "live", media: { remote: { port: 7000 } } }])
    const outputs = ua.handle(receive(reply(invite, 200, [], "f16", undefined, "")), 40)
    expect(sentRequests(outputs).map((request) => request.method)).toStrictEqual(["ACK", "BYE"])
  })

  it("puts its media on the core's own address when the command names only a port", () => {
    const ua = phone()
    const command = {
      type: "call",
      call: "c1",
      uri: "sip:b@x",
      to: bob,
      media: { port: 40_000 },
    } as const
    const [invite] = sentRequests(ua.handle({ type: "command", command }, 0))
    expect(new TextDecoder().decode(invite?.body)).toContain("c=IN IP4 192.0.2.10\r\n")
    const v6 = { ...command, call: "c2", media: { host: "[2001:db8::10]", port: 40_000 } }
    const [other] = sentRequests(ua.handle({ type: "command", command: v6 }, 0))
    expect(new TextDecoder().decode(other?.body)).toContain("c=IN IP6 2001:db8::10\r\n")
  })

  it("hangs up a 200 whose answer it cannot play even after usable early media", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    ua.handle(receive(reply(invite, 183, [], "t2", null, sdp())), 10)
    const outputs = ua.handle(
      receive(reply(invite, 200, [], "t2", undefined, sdp({ formats: [18] }))),
      20,
    )
    const [, bye] = sentRequests(outputs)
    expect(bye?.method).toBe("BYE")
    if (!bye) throw new Error("No BYE")
    expect(getHeader(bye, "Reason")).toBe('SIP;cause=488;text="Incompatible media"')
    expect(events(ua.handle(receive(reply(bye, 200)), 30))).toStrictEqual([
      { type: "call", call: "c1", state: "ended", ended: { by: "local", reason: "incompatible" } },
    ])
  })

  it("copes with a 200 that has no To tag", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    const tagless = reply(invite, 200).replace(";tag=t2", "")
    expect(events(ua.handle(receive(tagless), 10))).toMatchObject([{ state: "live" }])
    expect(
      sentRequests(ua.handle(receive(tagless), 20)).map((request) => request.method),
    ).toStrictEqual(["ACK"])
    const ours = invite.from.params.get("tag") ?? ""
    const hangup = ua.handle(receive(inDialog("BYE", 3, ours).replace(";tag=t2", "")), 30)
    expect(sentResponses(hangup)).toStrictEqual([200])
    expect(events(hangup)).toMatchObject([{ state: "ended", ended: { by: "remote" } }])
  })

  it("acknowledges a retransmitted 200 from an extra fork without another BYE", () => {
    const { ua, invite } = live()
    ua.handle(receive(reply(invite, 200, [], "t3")), 20)
    expect(
      sentRequests(ua.handle(receive(reply(invite, 200, [], "t3")), 30)).map(
        (request) => request.method,
      ),
    ).toStrictEqual(["ACK"])
  })

  it("counts a call as cancelled when it ended before any answer and the INVITE timed out", () => {
    const ua = phone()
    ua.handle(call(), 0)
    expect(ua.handle(end(), 10)).toStrictEqual([])
    const outputs: CoreOutput[] = []
    for (let now = 500; now <= 33_000; now += 500)
      outputs.push(...ua.handle({ type: "timeout" }, now))
    expect(events(outputs)).toContainEqual({
      type: "call",
      call: "c1",
      state: "ended",
      ended: { by: "local", reason: "cancelled" },
    })
  })

  it("answers the far end's BYE that crosses its own and ends once as its own hang-up", () => {
    const { ua, ourTag } = live()
    ua.handle(end(), 100)
    const crossing = ua.handle(receive(inDialog("BYE", 7, ourTag)), 110)
    expect(sentResponses(crossing)).toStrictEqual([200])
    expect(events(crossing)).toStrictEqual([
      { type: "call", call: "c1", state: "ended", ended: { by: "local", reason: "hangup" } },
    ])
  })

  it("reports the end only once when its crossed BYE is answered or times out", () => {
    const answered = live()
    const [bye] = sentRequests(answered.ua.handle(end(), 100))
    answered.ua.handle(receive(inDialog("BYE", 7, answered.ourTag)), 110)
    if (!bye) throw new Error("No BYE")
    expect(answered.ua.handle(receive(reply(bye, 200)), 120)).toStrictEqual([])
    const silent = live()
    silent.ua.handle(end(), 100)
    silent.ua.handle(receive(inDialog("BYE", 7, silent.ourTag)), 110)
    const later: CoreOutput[] = []
    for (let now = 500; now <= 40_000; now += 500)
      later.push(...silent.ua.handle({ type: "timeout" }, now))
    expect(events(later)).toStrictEqual([])
  })
})

describe("calls under pressure from the details", () => {
  const tls = { transport: "TLS", host: "192.0.2.20", port: 5061 } as const
  const overTls = (id: string) =>
    ({
      type: "command",
      command: { type: "call", call: id, uri: "sip:bob@example.com", to: tls, media },
    }) as const
  const methodsOf = (outputs: CoreOutput[]) =>
    sentRequests(outputs).map((request) => request.method)
  const callEvents = (outputs: CoreOutput[]) =>
    events(outputs).filter((event) => event.type === "call")

  it("reports ringing once and cancels once however often it rings", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    expect(callEvents(ua.handle(receive(reply(invite, 180)), 10))).toHaveLength(1)
    expect(callEvents(ua.handle(receive(reply(invite, 180)), 20))).toStrictEqual([])
    expect(methodsOf(ua.handle(end(), 30))).toStrictEqual(["CANCEL"])
    expect(methodsOf(ua.handle(receive(reply(invite, 180)), 40))).toStrictEqual([])
    expect(callEvents(ua.handle(receive(reply(invite, 183)), 50))).toStrictEqual([])
  })

  it("does not answer a challenge for a call it already ended", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    ua.handle(receive(reply(invite, 100)), 10)
    expect(methodsOf(ua.handle(end(), 20))).toStrictEqual(["CANCEL"])
    const challenged = ua.handle(
      receive(reply(invite, 407, ['Proxy-Authenticate: Digest realm="x", nonce="n"'])),
      30,
    )
    expect(methodsOf(challenged)).toStrictEqual(["ACK"])
    expect(callEvents(challenged)).toMatchObject([
      { state: "ended", ended: { reason: "cancelled" } },
    ])
  })

  it("waits for a provisional answer to the new INVITE before it cancels after a challenge", () => {
    const ua = createCore({
      address: alice,
      aor: "sip:alice@example.com",
      random: createRandom(1),
      credentials: { username: "alice", password: "secret" },
    })
    const [first] = sentRequests(ua.handle(call(), 0))
    if (!first) throw new Error("No INVITE")
    ua.handle(receive(reply(first, 100)), 10)
    const retry = sentRequests(
      ua.handle(
        receive(reply(first, 407, ['Proxy-Authenticate: Digest realm="x", nonce="n"'])),
        20,
      ),
    )
    const second = retry.find((request) => request.method === "INVITE")
    if (!second) throw new Error("No second INVITE")
    expect(second.cseq.seq).toBe(2)
    expect(methodsOf(ua.handle(end(), 30))).toStrictEqual([])
    const cancel = sentRequests(ua.handle(receive(reply(second, 180)), 40))
    expect(cancel.map((request) => [request.method, request.cseq.seq])).toStrictEqual([
      ["CANCEL", 2],
    ])
  })

  it("waits for the final answer to its BYE", () => {
    const { ua } = live()
    const [bye] = sentRequests(ua.handle(end(), 100))
    if (!bye) throw new Error("No BYE")
    const trying = ua.handle(receive(reply(bye, 100)), 110)
    expect(callEvents(trying)).toStrictEqual([])
    expect(callEvents(ua.handle(receive(reply(bye, 200)), 120))).toMatchObject([{ state: "ended" }])
  })

  it("gives the BYE to an extra fork the next CSeq of that fork", () => {
    const { ua, invite } = live()
    const fork = sentRequests(ua.handle(receive(reply(invite, 200, [], "t3")), 20))
    expect(fork.map((request) => [request.method, request.cseq.seq])).toStrictEqual([
      ["ACK", 1],
      ["BYE", 2],
    ])
  })

  it("keeps ended calls for exactly 64·T1 from the moment they ended", () => {
    const ua = phone()
    const [first] = sentRequests(ua.handle(overTls("c1"), 0))
    if (!first) throw new Error("No INVITE")
    ua.handle(receive(reply(first, 486)), 10)
    expect(ua.nextDeadline()).toBe(32_010)
    const [second] = sentRequests(ua.handle(overTls("c2"), 500))
    if (!second) throw new Error("No INVITE")
    ua.handle(receive(reply(second, 486)), 600)
    expect(ua.nextDeadline()).toBe(32_010)
    ua.handle(receive(reply(first, 486)), 20_000)
    expect(ua.nextDeadline()).toBe(32_010)
    ua.handle({ type: "timeout" }, 32_010)
    expect(ua.nextDeadline()).toBe(32_600)
  })
})

describe("calls against a hostile far end", () => {
  const forged = (invite: SipRequest, status: number, fromTag: string, seq = 1, body = "") =>
    [
      `SIP/2.0 ${status} Forged`,
      "Via: SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bKforged",
      `From: <sip:alice@example.com>;tag=${fromTag}`,
      "To: <sip:bob@example.com>;tag=evil",
      `Call-ID: ${invite.callId}`,
      `CSeq: ${seq} INVITE`,
      "Contact: <sip:evil@203.0.113.66>",
      ...(body ? ["Content-Type: application/sdp"] : []),
      `Content-Length: ${body.length}`,
      "",
      body,
    ].join("\r\n")
  const callEvents = (outputs: CoreOutput[]) =>
    events(outputs).filter((event) => event.type === "call")

  it("ignores answers that do not belong to its INVITE", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    const ours = invite.from.params.get("tag") ?? ""
    for (const status of [183, 200, 486, 407]) {
      const body = status === 183 || status === 200 ? "v=0\r\n" : ""
      const outputs = ua.handle(receive(forged(invite, status, "someone", 1, body)), 10)
      expect(callEvents(outputs), `${status}`).toStrictEqual([])
      expect(sentRequests(outputs), `${status}`).toStrictEqual([])
    }
    expect(callEvents(ua.handle(receive(forged(invite, 200, ours, 9)), 20))).toStrictEqual([])
    expect(callEvents(ua.handle(receive(reply(invite, 200)), 30))).toMatchObject([
      { state: "live" },
    ])
    const late = ua.handle(receive(forged(invite, 486, ours)), 40)
    expect(callEvents(late)).toStrictEqual([])
    expect(sentRequests(late)).toStrictEqual([])
  })

  it("ends a call whose CANCEL was answered but whose INVITE never was", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    ua.handle(receive(reply(invite, 180)), 10)
    const [cancel] = sentRequests(ua.handle(end(), 20))
    if (!cancel) throw new Error("No CANCEL")
    ua.handle(receive(reply(cancel, 200)), 30)
    expect(ua.nextDeadline()).toBe(5030)
    expect(ua.handle({ type: "timeout" }, 5030)).toStrictEqual([])
    expect(ua.nextDeadline()).toBe(32_020)
    expect(ua.handle({ type: "timeout" }, 32_019)).toStrictEqual([])
    expect(callEvents(ua.handle({ type: "timeout" }, 32_020))).toStrictEqual([
      { type: "call", call: "c1", state: "ended", ended: { by: "local", reason: "cancelled" } },
    ])
    expect(sentRequests(ua.handle(receive(reply(invite, 487)), 32_100))).toStrictEqual([])
  })

  it("hangs up at most 16 extra forks", () => {
    const { ua, invite } = live()
    let byes = 0
    for (let fork = 0; fork < 40; fork++) {
      const outputs = ua.handle(receive(reply(invite, 200, [], `f${fork}`)), 20 + fork)
      byes += sentRequests(outputs).filter((request) => request.method === "BYE").length
    }
    expect(byes).toBe(16)
  })

  it.each([
    [
      "more than 32 routes",
      Array.from({ length: 33 }, (_, index) => `Record-Route: <sip:p${index}.example.com;lr>`),
    ],
    [
      "a route with headers",
      ["Record-Route: <sip:edge.example.com;lr>", "Record-Route: <sip:x.example.com?Subject=y>"],
    ],
  ])("drops a route set with %s", (_, headers) => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    ua.handle(receive(reply(invite, 200, headers)), 10)
    const [bye] = sentRequests(ua.handle(end(), 20))
    expect(bye?.headers.filter((header) => header.name === "Route")).toStrictEqual([])
  })

  it("does not trip over a Contact it cannot send to", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    const answer = reply(invite, 200, [], "t2", "<sip:bob@192.0.2.20?Subject=x>")
    const [ack] = sentRequests(ua.handle(receive(answer), 10))
    expect(ack?.uri).toBe("sip:bob@example.com")
    for (let now = 500; now < 33_000; now += 500) ua.handle({ type: "timeout" }, now)
    expect(sentRequests(ua.handle(end(), 33_000))[0]?.uri).toBe("sip:bob@example.com")
  })

  it("keeps its own copy of the media address", () => {
    const ua = phone()
    const local = { host: "192.0.2.10", port: 40_000 }
    const command = { type: "call", call: "c1", uri: "sip:b@x", to: bob, media: local } as const
    const [invite] = sentRequests(ua.handle({ type: "command", command }, 0))
    local.port = 1
    const [again] = sentRequests(ua.handle({ type: "timeout" }, 500))
    expect(again?.body).toStrictEqual(invite?.body)
    expect(new TextDecoder().decode(again?.body)).toContain("m=audio 40000 ")
  })
})

describe("calls through forking proxies and late answers", () => {
  const callEvents = (outputs: CoreOutput[]) =>
    events(outputs).filter((event) => event.type === "call")
  const methodsOf = (outputs: CoreOutput[]) =>
    sentRequests(outputs).map((request) => request.method)

  it("hangs up a 2xx from one branch that follows a final from another", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    const declined = ua.handle(receive(reply(invite, 603, [], "a")), 10)
    expect(methodsOf(declined)).toStrictEqual(["ACK"])
    expect(callEvents(declined)).toMatchObject([{ state: "ended", ended: { reason: "declined" } }])
    expect(methodsOf(ua.handle(receive(reply(invite, 200, [], "b")), 20))).toStrictEqual([
      "ACK",
      "BYE",
    ])
  })

  it("reports early media again when another fork or other SDP rings", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    const early = (tag: string, host: string) => reply(invite, 183, [], tag, null, sdp({ host }))
    const first = early("a", "10.0.0.1")
    const other = early("b", "10.0.0.2")
    const changed = early("b", "10.0.0.3")
    expect(callEvents(ua.handle(receive(first), 10))).toHaveLength(1)
    expect(callEvents(ua.handle(receive(other), 20))).toMatchObject([
      { media: { remote: { host: "10.0.0.2" } } },
    ])
    expect(callEvents(ua.handle(receive(other), 30))).toStrictEqual([])
    expect(callEvents(ua.handle(receive(changed), 40))).toMatchObject([
      { media: { remote: { host: "10.0.0.3" } } },
    ])
    const longer = early("b", "10.0.0.30")
    expect(callEvents(ua.handle(receive(longer), 50))).toHaveLength(1)
    expect(callEvents(ua.handle(receive(reply(invite, 180, [], "c")), 60))).toHaveLength(1)
    expect(callEvents(ua.handle(receive(reply(invite, 180, [], "d")), 70))).toHaveLength(1)
  })

  it("acknowledges and hangs up a 200 that arrives after the INVITE timed out", () => {
    const ua = phone()
    const [invite] = sentRequests(ua.handle(call(), 0))
    if (!invite) throw new Error("No INVITE")
    const outputs: CoreOutput[] = []
    for (let now = 500; now <= 32_000; now += 500)
      outputs.push(...ua.handle({ type: "timeout" }, now))
    expect(callEvents(outputs)).toMatchObject([{ state: "ended", ended: { reason: "dropped" } }])
    expect(methodsOf(ua.handle(receive(reply(invite, 200)), 32_100))).toStrictEqual(["ACK", "BYE"])
  })
})

describe("reasonFor", () => {
  it("calls a 487 the callee sent on its own cancelled", () => {
    expect(reasonFor(487)).toBe("cancelled")
  })

  it("calls 488 and 606 incompatible and other 6xx answers rejected", () => {
    expect(reasonFor(488)).toBe("incompatible")
    expect(reasonFor(606)).toBe("incompatible")
    expect(reasonFor(699)).toBe("rejected")
  })
})
