import { describe, expect, it } from "vitest"
import { createTrust } from "../../src/core/authenticator"
import { createIncoming } from "../../src/core/calls/incoming"
import { createOutgoing } from "../../src/core/calls/outgoing"
import { repeatAnswer } from "../../src/core/calls/repeat"
import { createReply, createRetryLater } from "../../src/core/calls/replies"
import type { CallContext } from "../../src/core/calls/types"
import { phraseFor } from "../../src/message/phrases"
import { createRandom } from "../../src/simulation/random"
import { defaultTimers } from "../../src/transaction/timers"
import { alice, aliceMedia, bob, bytes, parsedRequest, sdp } from "../helpers"

const context: CallContext = {
  identity: { address: alice, aor: "sip:alice@example.com", random: createRandom(1) },
  contact: { uri: "sip:alice@192.0.2.10", params: new Map() },
  credentials: undefined,
  trust: createTrust(),
  timers: defaultTimers,
}

const bye = parsedRequest(
  [
    "BYE sip:alice@192.0.2.10 SIP/2.0",
    "Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bKb1",
    "From: <sip:bob@example.com>;tag=b1",
    "To: <sip:alice@example.com>;tag=a1",
    "Call-ID: c1",
    "CSeq: 2 BYE",
    "",
    "",
  ].join("\r\n"),
)

const invite = parsedRequest(
  [
    "INVITE sip:alice@192.0.2.10 SIP/2.0",
    "Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bKi1",
    "From: <sip:bob@example.com>;tag=b1",
    "To: <sip:alice@example.com>",
    "Call-ID: c1",
    "CSeq: 1 INVITE",
    "",
    "",
  ].join("\r\n"),
)

describe("repeatAnswer (RFC 3261 §13.3.1.4)", () => {
  it("doubles from T1 up to T2 and stops for good at 64·T1", () => {
    const ok = createReply(invite, 200)
    const repeat = repeatAnswer("t1", ok, 0, defaultTimers)
    const times: number[] = []
    for (let at = repeat.deadline; at !== undefined; at = repeat.deadline) {
      if (repeat.expire(at).length > 0) times.push(at)
    }
    expect(times).toStrictEqual([
      500, 1500, 3500, 7500, 11_500, 15_500, 19_500, 23_500, 27_500, 31_500,
    ])
    expect(repeat.expired).toBe(true)
    expect(repeat.deadline).toBeUndefined()
    expect(repeat.expire(40_000)).toStrictEqual([])
    expect(repeat.seq).toBe(1)
  })

  it("does nothing before its deadline", () => {
    const repeat = repeatAnswer("t1", createReply(invite, 200), 0, defaultTimers)
    expect(repeat.expire(499)).toStrictEqual([])
    expect(repeat.deadline).toBe(500)
  })
})

describe("replies", () => {
  it("names common rejections and calls the rest Rejected", () => {
    expect(phraseFor(486)).toBe("Busy Here")
    expect(phraseFor(603)).toBe("Decline")
    expect(phraseFor(487)).toBe("Request Terminated")
    expect(phraseFor(499)).toBe("Rejected")
  })

  it("adds the SDP type only with a body and Allow only with a Contact", () => {
    const plain = createReply(invite, 486, { tag: "a1" })
    expect(plain.headers).toStrictEqual([])
    expect(plain.to.params.get("tag")).toBe("a1")
    const full = createReply(invite, 200, {
      contact: context.contact,
      sdp: bytes("v=0\r\n"),
    })
    expect(full.headers.map((header) => header.name)).toStrictEqual(["Allow", "Content-Type"])
  })
})

describe("createRetryLater (RFC 3261 §14.2)", () => {
  it.each([
    [0, "0"],
    [0.5, "5"],
    [0.999, "10"],
    [1, "10"],
  ])("asks to retry after 0 to 10 seconds (random %s gives %s)", (value, seconds) => {
    const retry = createRetryLater(invite, () => value)
    expect(retry.status).toBe(500)
    expect(retry.headers).toStrictEqual([{ name: "Retry-After", value: seconds }])
  })
})

describe("call paths the core never takes", () => {
  it("answers a request to an outgoing call that has no dialog yet with 481", () => {
    const call = createOutgoing(
      { call: "c1", uri: "sip:bob@example.com", to: bob, media: aliceMedia },
      context,
    )
    expect(call.request(bye, "t1", 0)).toMatchObject([
      { type: "respond", response: { status: 481 } },
    ])
  })

  it("rejects with 488 when accepting an offer it cannot play, which admission would refuse", () => {
    const g729 = { ...invite, body: bytes(sdp({ formats: [18] })) }
    const call = createIncoming({ invite: g729, transaction: "t1", from: bob }, context, 0)
    expect(call.accept(aliceMedia, 10)).toMatchObject([
      { type: "respond", response: { status: 488 } },
      {
        type: "event",
        event: { state: "ended", ended: { by: "local", reason: "incompatible", status: 488 } },
      },
    ])
  })

  it("has nothing to do with responses, timeouts or ACKs before it answers", () => {
    const call = createIncoming({ invite, transaction: "t1", from: bob }, context, 0)
    expect(call.response(createReply(bye, 200), 0)).toStrictEqual([])
    expect(call.timeout(bye)).toStrictEqual([])
    expect(call.acknowledge(bye)).toStrictEqual([])
  })
})
