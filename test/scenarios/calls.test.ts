import { describe, expect, it } from "vitest"
import {
  type CallEnd,
  type CoreEvent,
  createCore,
  getHeader,
  getHeaders,
  type Random,
  replay,
} from "../../src"
import { createRecordedCore, type RecordedCore } from "../../src/recorder/recorder"
import { type LinkConditions, latency, loss } from "../../src/simulation/network/conditions"
import { createSimulation } from "../../src/simulation/simulation"
import { formatTrace } from "../../src/simulation/trace"
import { type Callee, type CalleeOptions, callee } from "../callee"
import { alice, aliceMedia, bob } from "../helpers"

const account = { username: "alice", password: "secret" }
const media = aliceMedia
const negotiated = {
  remote: { host: "192.0.2.20", port: 4000 },
  codec: "PCMU",
  payloadType: 0,
  dtmf: 101,
  ptime: 20,
  direction: "sendrecv",
} as const
const phone =
  (password = "secret") =>
  (random: Random) =>
    createCore({
      address: alice,
      aor: "sip:alice@example.com",
      random,
      credentials: { ...account, password },
    })

function setup(
  options: CalleeOptions = {},
  internet: LinkConditions = { latency: latency.fixed(20) },
  seed = 1,
  password = "secret",
) {
  const simulation = createSimulation({ seed, internet })
  const ua = simulation.addNode("phone", alice, phone(password))
  let far: Callee | undefined
  simulation.addNode("callee", bob, (random) => {
    far = callee(options)(random)
    return far
  })
  if (!far) throw new Error("No callee")
  const dial = (call = "c1") =>
    simulation.command(ua, { type: "call", call, uri: "sip:bob@example.com", to: bob, media })
  const end = (at: number, call = "c1") =>
    simulation.at(at, () => simulation.command(ua, { type: "end", call }))
  return { simulation, ua, callee: far, dial, end }
}

function states(events: readonly CoreEvent[]): string[] {
  return events.flatMap((event) => (event.type === "call" ? [event.state] : []))
}

function ended(events: readonly CoreEvent[]): CallEnd | undefined {
  for (const event of events)
    if (event.type === "call" && event.state === "ended") return event.ended
  return undefined
}

const methods = (far: Callee) => far.received.map((request) => request.method)

describe("outgoing calls", () => {
  it("rings, connects with the answer and hangs up", () => {
    const { simulation, ua, dial, end } = setup()
    dial()
    end(5000)
    simulation.run(10_000)
    expect(formatTrace(simulation.trace)).toBe(
      [
        "     0ms  phone → callee  INVITE sip:bob@example.com SIP/2.0  (+20ms)",
        "    20ms  callee → phone  SIP/2.0 100 Ringing  (+20ms)",
        "    20ms  callee → phone  SIP/2.0 180 Ringing  (+20ms)",
        "    20ms  callee → phone  SIP/2.0 200 OK  (+20ms)",
        "    40ms  phone → callee  ACK sip:bob@192.0.2.20:5060;fork0 SIP/2.0  (+20ms)",
        "  5000ms  phone → callee  BYE sip:bob@192.0.2.20:5060;fork0 SIP/2.0  (+20ms)",
        "  5020ms  callee → phone  SIP/2.0 200 OK  (+20ms)",
      ].join("\n"),
    )
    const events = ua.events.filter((event) => event.type === "call")
    expect(events).toStrictEqual([
      { type: "call", call: "c1", state: "ringing", status: 180 },
      { type: "call", call: "c1", state: "live", media: negotiated },
      { type: "call", call: "c1", state: "ended", ended: { by: "local", reason: "hangup" } },
    ])
  })

  it("sends a well-formed INVITE with the offer", () => {
    const { simulation, callee: far, dial } = setup({ answer: 0 })
    dial()
    simulation.run(100)
    const [invite] = far.received
    expect(invite).toMatchObject({
      method: "INVITE",
      uri: "sip:bob@example.com",
      callId: "c1",
      from: { uri: "sip:alice@example.com" },
      to: { uri: "sip:bob@example.com" },
      cseq: { seq: 1, method: "INVITE" },
      contact: [{ uri: "sip:alice@192.0.2.10:5060" }],
    })
    expect(new TextDecoder().decode(invite?.body)).toMatch(
      new RegExp(
        [
          "^v=0",
          "o=- \\d+ 1 IN IP4 192\\.0\\.2\\.10",
          "s=-",
          "c=IN IP4 192\\.0\\.2\\.10",
          "t=0 0",
          "m=audio 40000 RTP/AVP 0 8 101",
          "a=rtpmap:0 PCMU/8000",
          "a=rtpmap:8 PCMA/8000",
          "a=rtpmap:101 telephone-event/8000",
          "a=fmtp:101 0-16",
          "a=ptime:20",
          "a=sendrecv",
          "$",
        ].join("\r\n"),
      ),
    )
    expect(invite?.from.params.get("tag")).toMatch(/^[a-z0-9]{10}$/)
    expect(invite && getHeader(invite, "Content-Type")).toBe("application/sdp")
    expect(invite && getHeader(invite, "Allow")).toBe("ACK, BYE, CANCEL, INVITE, OPTIONS")
  })

  it.each([
    [486, "busy"],
    [600, "busy"],
    [603, "declined"],
    [607, "declined"],
    [404, "not-found"],
    [604, "not-found"],
    [480, "no-answer"],
    [408, "no-answer"],
    [503, "unavailable"],
    [500, "unavailable"],
    [302, "rejected"],
    [403, "rejected"],
  ])("ends with %i as %s", (status, reason) => {
    const { simulation, ua, callee: far, dial } = setup({ answer: status })
    dial()
    simulation.run(1000)
    expect(states(ua.events)).toStrictEqual(["ringing", "ended"])
    expect(ended(ua.events)).toStrictEqual({ by: "remote", reason, status })
    expect(methods(far)).toStrictEqual(["INVITE", "ACK"])
  })

  it("gives up when nobody answers the INVITE at all", () => {
    const { simulation, ua, dial } = setup()
    simulation.network.disconnect("callee")
    dial()
    simulation.run(40_000)
    expect(states(ua.events)).toStrictEqual(["ended"])
    expect(ended(ua.events)).toStrictEqual({ by: "remote", reason: "timeout" })
  })

  it("answers a proxy challenge and connects", () => {
    const { simulation, ua, callee: far, dial } = setup({ challenge: 407 })
    dial()
    simulation.run(1000)
    expect(states(ua.events)).toStrictEqual(["ringing", "live"])
    const invites = far.received.filter((request) => request.method === "INVITE")
    expect(invites.map((invite) => invite.cseq.seq)).toStrictEqual([1, 2])
    expect(invites[1] && getHeader(invites[1], "Proxy-Authorization")).toMatch(
      /^Digest username="alice"/,
    )
    const ack = far.received.find((request) => request.method === "ACK" && request.cseq.seq === 2)
    expect(ack && getHeader(ack, "Proxy-Authorization")).toBe(
      invites[1] && getHeader(invites[1], "Proxy-Authorization"),
    )
  })

  it("answers a www challenge and stops after a wrong password", () => {
    const right = setup({ challenge: 401 })
    right.dial()
    right.simulation.run(1000)
    expect(states(right.ua.events)).toStrictEqual(["ringing", "live"])
    const wrong = setup({ challenge: 401 }, undefined, 1, "wrong")
    wrong.dial()
    wrong.simulation.run(1000)
    expect(ended(wrong.ua.events)).toStrictEqual({
      by: "remote",
      reason: "unauthorized",
      status: 401,
    })
    expect(methods(wrong.callee).filter((method) => method === "INVITE")).toHaveLength(2)
  })

  it("cancels while ringing", () => {
    const { simulation, ua, callee: far, dial, end } = setup({ answerAfter: 10_000 })
    dial()
    end(1000)
    simulation.run(12_000)
    expect(states(ua.events)).toStrictEqual(["ringing", "ended"])
    expect(ended(ua.events)).toStrictEqual({ by: "local", reason: "cancelled" })
    expect(methods(far)).toStrictEqual(["INVITE", "CANCEL", "ACK"])
    const cancel = far.received[1]
    expect(cancel?.cseq).toStrictEqual({ seq: 1, method: "CANCEL" })
    expect(cancel?.via[0]?.params.get("branch")).toBe(far.received[0]?.via[0]?.params.get("branch"))
  })

  it("waits for a provisional response before it cancels", () => {
    const {
      simulation,
      ua,
      callee: far,
      dial,
      end,
    } = setup({
      ring: [180],
      ringAfter: 500,
      answerAfter: 10_000,
    })
    dial()
    end(10)
    simulation.run(12_000)
    expect(methods(far).filter((method) => method !== "INVITE")).toStrictEqual(["CANCEL", "ACK"])
    const cancelAt = simulation.trace.find((packet) => packet.summary.startsWith("CANCEL"))?.sentAt
    expect(cancelAt).toBeGreaterThanOrEqual(520)
    expect(states(ua.events)).toStrictEqual(["ended"])
    expect(ended(ua.events)).toStrictEqual({ by: "local", reason: "cancelled" })
  })

  it("acknowledges and hangs up a 200 that crossed its CANCEL", () => {
    const { simulation, ua, callee: far, dial, end } = setup({ answerAfter: 1000 })
    dial()
    end(1010)
    simulation.run(5000)
    expect(methods(far)).toStrictEqual(["INVITE", "CANCEL", "ACK", "BYE"])
    expect(states(ua.events)).toStrictEqual(["ringing", "ended"])
    expect(ended(ua.events)).toStrictEqual({ by: "local", reason: "cancelled" })
  })

  it("ends when the callee hangs up", () => {
    const { simulation, ua, dial } = setup({ hangupAfter: 2000 })
    dial()
    simulation.run(5000)
    expect(states(ua.events)).toStrictEqual(["ringing", "live", "ended"])
    expect(ended(ua.events)).toStrictEqual({ by: "remote", reason: "hangup" })
    const ok = simulation.trace.filter(
      (packet) => packet.from === "phone" && packet.summary === "SIP/2.0 200 OK",
    )
    expect(ok).toHaveLength(1)
  })

  it("keeps the first fork and hangs up the others", () => {
    const { simulation, ua, callee: far, dial } = setup({ forks: 3 })
    dial()
    simulation.run(2000)
    expect(states(ua.events)).toStrictEqual(["ringing", "live"])
    const acks = far.received.filter((request) => request.method === "ACK")
    expect(acks.map((ack) => ack.to.params.get("tag"))).toStrictEqual(["fork0", "fork1", "fork2"])
    const byes = far.received.filter((request) => request.method === "BYE")
    expect(byes.map((bye) => bye.to.params.get("tag"))).toStrictEqual(["fork1", "fork2"])
  })

  it("follows the route set and the remote target in the dialog", () => {
    const {
      simulation,
      callee: far,
      dial,
      end,
    } = setup({
      recordRoute: ["<sip:edge.example.com;lr>", "<sip:core.example.com;lr>"],
    })
    dial()
    end(1000)
    simulation.run(2000)
    const bye = far.received.find((request) => request.method === "BYE")
    expect(bye?.uri).toBe("sip:bob@192.0.2.20:5060;fork0")
    expect(bye && getHeaders(bye, "Route")).toStrictEqual([
      "<sip:core.example.com;lr>",
      "<sip:edge.example.com;lr>",
    ])
    expect(bye?.cseq).toStrictEqual({ seq: 2, method: "BYE" })
  })

  it("acknowledges every retransmitted 200 when its ACK got lost", () => {
    const { simulation, callee: far, dial } = setup()
    simulation.at(30, () => simulation.network.block("phone", "callee"))
    simulation.at(1500, () => simulation.network.unblock("phone", "callee"))
    dial()
    simulation.run(5000)
    expect(far.acked.has("fork0")).toBe(true)
    const acks = simulation.trace.filter((packet) => packet.summary.startsWith("ACK"))
    expect(acks.length).toBeGreaterThan(2)
  })

  it("connects and hangs up through 30 % loss and duplicates in every seed", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const lossy = { latency: latency.uniform(10, 80), loss: loss.random(0.3), duplicate: 0.1 }
      const { simulation, ua, callee: far, dial, end } = setup({}, lossy, seed)
      dial()
      end(20_000)
      simulation.run(60_000)
      const trace = `seed ${seed}\n${formatTrace(simulation.trace)}`
      expect(
        states(ua.events).filter((state) => state !== "ringing"),
        trace,
      ).toStrictEqual(["live", "ended"])
      expect(ended(ua.events), trace).toStrictEqual({ by: "local", reason: "hangup" })
      expect(far.acked.has("fork0"), trace).toBe(true)
      expect(methods(far), trace).toContain("BYE")
    }
  })

  it("ends once when both sides hang up at the same time", () => {
    const { simulation, ua, dial, end } = setup({ hangupAfter: 1960 })
    dial()
    end(2000)
    simulation.run(5000)
    expect(states(ua.events)).toStrictEqual(["ringing", "live", "ended"])
  })

  it("records a whole call that replays byte for byte", () => {
    const simulation = createSimulation({
      seed: 3,
      internet: { latency: latency.uniform(10, 80), loss: loss.random(0.2) },
    })
    let recorded: RecordedCore | undefined
    const ua = simulation.addNode("phone", alice, (random) => {
      recorded = createRecordedCore({
        address: alice,
        aor: "sip:alice@example.com",
        random,
        credentials: account,
      })
      return recorded
    })
    simulation.addNode("callee", bob, callee({ challenge: 407, hangupAfter: 3000 }))
    simulation.command(ua, {
      type: "call",
      call: "c1",
      uri: "sip:bob@example.com",
      to: bob,
      media,
    })
    simulation.run(60_000)
    expect(states(ua.events).filter((state) => state !== "ringing")).toStrictEqual([
      "live",
      "ended",
    ])
    expect(replay(recorded?.recording() ?? "")).toMatchObject({ ok: true })
  })

  it("ends the call instead of answering a challenged BYE", () => {
    const { simulation, ua, callee: far, dial, end } = setup({ challengeBye: 407 })
    dial()
    end(1000)
    simulation.run(5000)
    expect(far.received.filter((request) => request.method === "BYE")).toHaveLength(1)
    expect(ended(ua.events)).toStrictEqual({ by: "local", reason: "hangup" })
  })

  it("cancels cleanly through 30 % loss and duplicates in every seed", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const lossy = { latency: latency.uniform(10, 80), loss: loss.random(0.3), duplicate: 0.1 }
      const { simulation, ua, dial, end } = setup({ answerAfter: 60_000 }, lossy, seed)
      dial()
      end(3000)
      simulation.run(80_000)
      const trace = `seed ${seed}\n${formatTrace(simulation.trace)}`
      expect(ended(ua.events), trace).toStrictEqual({ by: "local", reason: "cancelled" })
    }
  })

  it("follows the far end hanging up through 30 % loss and duplicates in every seed", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const lossy = { latency: latency.uniform(10, 80), loss: loss.random(0.3), duplicate: 0.1 }
      const { simulation, ua, dial } = setup({ hangupAfter: 5000 }, lossy, seed)
      dial()
      simulation.run(80_000)
      const trace = `seed ${seed}\n${formatTrace(simulation.trace)}`
      expect(ended(ua.events), trace).toStrictEqual({ by: "remote", reason: "hangup" })
    }
  })
})

describe("hold from the far end (RFC 3264 §8.4)", () => {
  const directions = (events: readonly CoreEvent[]) =>
    events.flatMap((event) =>
      event.type === "call" && event.state === "live" ? [event.media?.direction] : [],
    )

  it("follows hold and resume and answers both with the right direction", () => {
    const { simulation, ua, callee: far, dial, end } = setup({ holdAfter: 2000, resumeAfter: 4000 })
    dial()
    end(6000)
    simulation.run(10_000)
    expect(directions(ua.events)).toStrictEqual(["sendrecv", "recvonly", "sendrecv"])
    const sent = far.sent.flatMap((message) => ("method" in message ? [message.method] : []))
    expect(sent).toStrictEqual(["INVITE", "ACK", "INVITE", "ACK"])
    expect(methods(far)).toStrictEqual(["INVITE", "ACK", "BYE"])
    expect(ended(ua.events)).toStrictEqual({ by: "local", reason: "hangup" })
  })

  it("follows hold and resume through 30 % loss and duplicates in every seed", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const lossy = { latency: latency.uniform(10, 80), loss: loss.random(0.3), duplicate: 0.1 }
      const options = { holdAfter: 3000, resumeAfter: 15_000 }
      const { simulation, ua, dial, end } = setup(options, lossy, seed)
      dial()
      end(30_000)
      simulation.run(120_000)
      const trace = `seed ${seed}\n${formatTrace(simulation.trace)}`
      expect(directions(ua.events), trace).toStrictEqual(["sendrecv", "recvonly", "sendrecv"])
      expect(ended(ua.events), trace).toStrictEqual({ by: "local", reason: "hangup" })
      expect(ua.core.nextDeadline(), trace).toBeUndefined()
    }
  })
})
