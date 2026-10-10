import { describe, expect, it } from "vitest"
import type { TransportAddress } from "../../src"
import { type LinkConditions, latency, loss } from "../../src/simulation/network/conditions"
import { createNetwork } from "../../src/simulation/network/network"
import { profiles } from "../../src/simulation/network/profiles"
import type { PacketRecord } from "../../src/simulation/network/types"
import { createSimulation } from "../../src/simulation/simulation"
import { traceStats } from "../../src/simulation/stats"
import { alice, bob } from "../helpers"
import { settle, tolerance } from "../simulation/support"

const carol: TransportAddress = { transport: "UDP", host: "192.0.2.30", port: 5060 }
const payload = new Uint8Array(200)

function blast(
  internet: LinkConditions,
  count: number,
  access: { alice?: LinkConditions; bob?: LinkConditions } = {},
  seed = 1,
): readonly PacketRecord[] {
  const net = createNetwork({ seed, internet })
  net.attach("alice", alice, { access: access.alice ?? {} })
  net.attach("bob", bob, { access: access.bob ?? {} })
  for (let index = 0; index < count; index++) net.send("alice", bob, payload, index)
  settle(net)
  return net.trace
}

const deliveredShare = (trace: readonly PacketRecord[]) =>
  traceStats(trace).delivered / trace.length

describe("network statistics over large samples", () => {
  it("adds the latency of every hop", () => {
    const trace = blast({ latency: latency.fixed(20) }, 100, {
      alice: { latency: latency.fixed(10) },
      bob: { latency: latency.fixed(5) },
    })
    expect(new Set(trace.map((packet) => (packet.fates[0]?.at ?? 0) - packet.sentAt))).toEqual(
      new Set([35]),
    )
  })

  it("matches the configured loss rate", () => {
    expect(
      Math.abs(deliveredShare(blast({ loss: loss.random(0.05) }, 20_000)) - 0.95),
    ).toBeLessThan(tolerance(0.95, 20_000))
  })

  it("compounds loss along the path", () => {
    const trace = blast({}, 20_000, {
      alice: { loss: loss.random(0.1) },
      bob: { loss: loss.random(0.1) },
    })
    expect(Math.abs(deliveredShare(trace) - 0.81)).toBeLessThan(tolerance(0.81, 20_000))
    expect(traceStats(trace).dropped.loss).toBe(trace.length - traceStats(trace).delivered)
  })

  it("clusters burst loss", () => {
    const runs = (trace: readonly PacketRecord[]) => {
      const lost = trace.map((packet) => packet.fates[0]?.type === "dropped")
      const starts = lost.filter((value, index) => value && !lost[index - 1]).length
      return lost.filter(Boolean).length / starts
    }
    expect(runs(blast({ loss: loss.burst(0.1, 5) }, 50_000))).toBeGreaterThan(4)
    expect(runs(blast({ loss: loss.random(0.1) }, 50_000))).toBeLessThan(1.3)
  })

  it("duplicates and corrupts at the configured rates", () => {
    const stats = traceStats(blast({ duplicate: 0.05, corrupt: 0.02 }, 50_000))
    const copies = stats.delivered + stats.duplicates
    expect(Math.abs(stats.duplicates / stats.sent - 0.05)).toBeLessThan(tolerance(0.05, stats.sent))
    expect(Math.abs(stats.corrupted / copies - 0.02)).toBeLessThan(tolerance(0.02, copies))
  })

  it("reorders with jitter and keeps order on ordered links", () => {
    const order = (conditions: LinkConditions) =>
      blast(conditions, 500)
        .flatMap((packet) => packet.fates.map((fate) => ({ id: packet.id, at: fate.at })))
        .sort((a, b) => a.at - b.at || a.id - b.id)
        .map((delivery) => delivery.id)
    const inOrder = Array.from({ length: 500 }, (_, index) => index + 1)
    expect(order({ latency: latency.uniform(0, 100) })).not.toEqual(inOrder)
    expect(order({ latency: latency.uniform(0, 100), ordered: true })).toEqual(inOrder)
  })

  it("keeps the fates of one link independent of conditions elsewhere", () => {
    const run = (bobAccess: LinkConditions) => {
      const net = createNetwork({
        seed: 9,
        internet: { latency: latency.uniform(5, 80), loss: loss.random(0.2) },
      })
      net.attach("alice", alice, { access: profiles.badWifi })
      net.attach("bob", bob, { access: bobAccess })
      net.attach("carol", carol)
      for (let index = 0; index < 1000; index++) {
        net.send("alice", carol, payload, index * 3)
        net.send("alice", bob, payload, index * 3 + 1)
      }
      settle(net)
      return net.trace.filter((packet) => packet.to === "carol")
    }
    expect(run({ loss: loss.random(0.9), latency: latency.normal(300, 100) })).toEqual(run({}))
  })

  it("is reproducible per seed and differs between seeds", () => {
    const lossy = { latency: latency.normal(40, 20), loss: loss.burst(0.1, 3), duplicate: 0.01 }
    expect(blast(lossy, 2000, {}, 4)).toEqual(blast(lossy, 2000, {}, 4))
    expect(blast(lossy, 2000, {}, 4)).not.toEqual(blast(lossy, 2000, {}, 5))
  })

  it("scales to many hosts exchanging thousands of packets", () => {
    const simulation = createSimulation({ seed: 11, internet: profiles.cable })
    const hosts = Array.from({ length: 60 }, (_, index) => {
      const address: TransportAddress = {
        transport: "UDP",
        host: `198.18.0.${index + 1}`,
        port: 5060,
      }
      simulation.network.attach(`host${index}`, address, {
        access: index % 2 ? profiles.wifi : profiles.lte,
      })
      return address
    })
    for (let round = 0; round < 100; round++) {
      hosts.forEach((_, index) => {
        const target = hosts[(index * 7 + round) % hosts.length] ?? alice
        simulation.network.send(`host${index}`, target, payload, round * 20)
      })
    }
    simulation.run()
    const stats = traceStats(simulation.trace)
    expect(stats.sent).toBe(6000)
    expect(stats.inFlight).toBe(0)
    expect(stats.delivered + stats.undelivered).toBe(stats.sent)
    expect(stats.delivered / stats.sent).toBeGreaterThan(0.95)
  })
})
