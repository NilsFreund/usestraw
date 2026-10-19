import { describe, expect, it } from "vitest"
import { type CallEnd, type CoreEvent, replay } from "../../src/core"
import { createRecordedCore, type RecordedCore } from "../../src/recorder/recorder"
import { type LinkConditions, latency, loss } from "../../src/simulation/network/conditions"
import { createSimulation, type SimulationNode } from "../../src/simulation/simulation"
import { formatTrace } from "../../src/simulation/trace"
import { type CalleeOptions, callee } from "../callee"
import { alice, bob, sdp } from "../helpers"

// The app's SDP stands in for what an RTCPeerConnection makes; a G.711 callee can play it
// The ICE password is masked in the recording, which still has to replay
const ours = (version = 1) =>
  `${sdp({ host: "192.0.2.10", port: 40_000, formats: [0], version })}a=ice-pwd:asd88fgpdd777uzjYhagZg\r\n`

function setup(options: CalleeOptions, internet: LinkConditions, seed: number) {
  const simulation = createSimulation({ seed, internet })
  let recorded: RecordedCore | undefined
  const ua = simulation.addNode("phone", alice, (random) => {
    recorded = createRecordedCore({
      address: alice,
      aor: "sip:alice@example.com",
      random,
      media: "sdp",
    })
    return recorded
  })
  simulation.addNode("callee", bob, callee(options))
  simulation.command(ua, {
    type: "call",
    call: "c1",
    uri: "sip:bob@example.com",
    to: bob,
    media: { sdp: ours() },
  })
  return { simulation, ua, recording: () => recorded?.recording() ?? "" }
}

// The app answers every new offer the moment it sees it, as a browser would
function answerOffers(
  simulation: ReturnType<typeof createSimulation>,
  ua: SimulationNode,
  until: number,
) {
  let answered = 0
  for (let at = 0; at <= until; at += 50) {
    simulation.at(at, () => {
      const offers = ua.events.filter((event) => event.type === "call" && event.state === "offer")
      for (; answered < offers.length; answered++) {
        const media = { sdp: ours(answered + 2) }
        simulation.command(ua, { type: "answer", call: "c1", media })
      }
    })
  }
}

const states = (events: readonly CoreEvent[]) =>
  events.flatMap((event) => (event.type === "call" ? [event.state] : []))

function ended(events: readonly CoreEvent[]): CallEnd | undefined {
  for (const event of events) {
    if (event.type === "call" && event.state === "ended") return event.ended
  }
  return undefined
}

describe("calls with the app's own SDP", () => {
  it("call a G.711 phone and hang up through 30 % loss and duplicates in every seed", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const lossy = { latency: latency.uniform(10, 80), loss: loss.random(0.3), duplicate: 0.1 }
      const { simulation, ua, recording } = setup({}, lossy, seed)
      simulation.at(30_000, () => simulation.command(ua, { type: "end", call: "c1" }))
      simulation.run(120_000)
      const trace = `seed ${seed}\n${formatTrace(simulation.trace)}`
      expect(
        states(ua.events).filter((state) => state !== "ringing"),
        trace,
      ).toStrictEqual(["live", "ended"])
      expect(ended(ua.events), trace).toStrictEqual({ by: "local", reason: "hangup" })
      expect(ua.core.nextDeadline(), trace).toBeUndefined()
      expect(replay(recording()), trace).toMatchObject({ ok: true })
    }
  })

  it("answer the far end's hold and resume through the app, through loss, in every seed", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const lossy = { latency: latency.uniform(10, 80), loss: loss.random(0.3), duplicate: 0.1 }
      const options = { holdAfter: 3000, resumeAfter: 15_000 }
      const { simulation, ua, recording } = setup(options, lossy, seed)
      answerOffers(simulation, ua, 30_000)
      simulation.at(30_000, () => simulation.command(ua, { type: "end", call: "c1" }))
      simulation.run(120_000)
      const trace = `seed ${seed}\n${formatTrace(simulation.trace)}`
      const offers = states(ua.events).filter((state) => state === "offer")
      expect(offers, trace).toStrictEqual(["offer", "offer"])
      expect(trace).not.toContain(" 488 ")
      expect(recording(), trace).toContain("o=bob 1 2 IN IP4 192.0.2.10")
      expect(recording(), trace).toContain("o=bob 1 3 IN IP4 192.0.2.10")
      expect(ended(ua.events), trace).toStrictEqual({ by: "local", reason: "hangup" })
      expect(ua.core.nextDeadline(), trace).toBeUndefined()
      expect(replay(recording()), trace).toMatchObject({ ok: true })
    }
  })
})
