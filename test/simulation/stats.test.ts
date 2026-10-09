import { describe, expect, it } from "vitest"
import { latency, loss } from "../../src/simulation/network/conditions"
import { createNetwork } from "../../src/simulation/network/network"
import type { Fate, PacketRecord } from "../../src/simulation/network/types"
import { traceStats } from "../../src/simulation/stats"
import { alice, bob } from "../helpers"

function packet(fates: Fate[], copies = 1): PacketRecord {
  return { id: 1, sentAt: 0, from: "a", to: "b", size: 1, summary: "", copies, fates }
}

const delivered = (corrupted = false): Fate => ({ type: "delivered", at: 1, host: "b", corrupted })
const lost: Fate = { type: "dropped", at: 1, reason: "loss", hop: "internet" }

describe("traceStats", () => {
  it("classifies every packet exactly once and counts copies separately", () => {
    expect(
      traceStats([
        packet([delivered()]),
        packet([delivered(), delivered(true)], 2),
        packet([lost]),
        packet([{ type: "dropped", at: 1, reason: "nat", hop: "ingress" }, delivered()], 2),
        packet([delivered()], 2),
        packet([]),
      ]),
    ).toEqual({
      sent: 6,
      delivered: 3,
      undelivered: 1,
      inFlight: 2,
      duplicates: 1,
      corrupted: 1,
      dropped: { outage: 0, mtu: 0, loss: 1, congestion: 0, nat: 1, unroutable: 0 },
    })
  })

  it("returns zeros for an empty trace", () => {
    expect(traceStats([])).toMatchObject({ sent: 0, delivered: 0, undelivered: 0, inFlight: 0 })
  })

  it("keeps sent equal to delivered, undelivered and in flight with duplicates and loss", () => {
    const net = createNetwork({
      seed: 3,
      internet: { latency: latency.uniform(5, 50), duplicate: 0.3, loss: loss.random(0.3) },
    })
    net.attach("alice", alice)
    net.attach("bob", bob, { access: { loss: loss.random(0.2) } })
    for (let index = 0; index < 2000; index++) net.send("alice", bob, new Uint8Array(10), index)
    for (const checkpoint of [500, 1500, Number.POSITIVE_INFINITY]) {
      for (
        let next = net.nextEvent();
        next !== undefined && next <= checkpoint;
        next = net.nextEvent()
      ) {
        net.step(next)
      }
      const stats = traceStats(net.trace)
      expect(stats.delivered + stats.undelivered + stats.inFlight).toBe(stats.sent)
    }
    expect(traceStats(net.trace).inFlight).toBe(0)
    expect(traceStats(net.trace).duplicates).toBeGreaterThan(0)
  })
})
