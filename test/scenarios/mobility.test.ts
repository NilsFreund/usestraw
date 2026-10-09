import { describe, expect, it } from "vitest"
import type { Address } from "../../src"
import { latency } from "../../src/simulation/network/conditions"
import { profiles } from "../../src/simulation/network/profiles"
import { degrade, flapping, handover, partition } from "../../src/simulation/scenarios"
import { createSimulation, type SimulationOptions } from "../../src/simulation/simulation"
import { alice, bob, options, outcomes, userAgent } from "../helpers"

function commute(simulationOptions: SimulationOptions) {
  const simulation = createSimulation(simulationOptions)
  const caller = simulation.addNode("alice", alice, userAgent("alice", alice), {
    access: profiles.wifi,
  })
  const callee = simulation.addNode("bob", bob, userAgent("bob", bob), { access: profiles.fiber })
  const ping = (at: number) => simulation.at(at, () => simulation.command(caller, options(bob)))
  return { simulation, caller, callee, ping }
}

const lte: Address = { transport: "UDP", host: "100.64.33.7", port: 5060 }

describe("mobility", () => {
  it("loses the reply in flight during a Wi-Fi to LTE handover and recovers afterwards", () => {
    const { simulation, caller, ping } = commute({
      seed: 1,
      internet: { latency: latency.fixed(50) },
    })
    ping(0)
    handover(simulation, "alice", 60, lte, { access: profiles.lte })
    ping(40_000)
    simulation.run()
    expect(outcomes(caller.events)).toEqual(["timeout", "response"])
    expect(simulation.trace[1]?.fates).toMatchObject([{ reason: "unroutable", hop: "ingress" }])
  })

  it("moves behind a carrier NAT and is seen with the carrier address", () => {
    const { simulation, caller, callee, ping } = commute({ seed: 2 })
    simulation.network.addNat("carrier", { host: "198.51.100.1" })
    handover(simulation, "alice", 1000, lte, { nat: "carrier", access: profiles.lte })
    ping(2000)
    simulation.run()
    expect(outcomes(caller.events)).toEqual(["response"])
    const request = callee.events.find((event) => event.type === "request")
    expect(request?.type === "request" && request.from.host).toBe("198.51.100.1")
  })

  it("survives a train ride with flapping coverage, identically on every replay", () => {
    const ride = () => {
      const { simulation, caller, ping } = commute({ seed: 3, internet: profiles.fiber })
      simulation.at(0, () => simulation.network.setAccess("alice", profiles.lte))
      flapping(simulation, "alice", { from: 5000, every: 20_000, duration: 6000, count: 6 })
      for (let at = 0; at < 120_000; at += 5000) ping(at)
      simulation.run()
      return outcomes(caller.events)
    }
    const first = ride()
    expect(first).toHaveLength(24)
    expect(first).toContain("response")
    expect(first).toContain("timeout")
    expect(ride()).toEqual(first)
  })

  it("heals after a partition between two sites", () => {
    const { simulation, caller, ping } = commute({ seed: 4 })
    partition(simulation, ["alice", "bob"], 5000, 10_000)
    for (const at of [0, 10_000, 50_000]) ping(at)
    simulation.run()
    expect(outcomes(caller.events)).toEqual(["response", "timeout", "response"])
    const delivered = simulation.trace
      .filter((packet) => packet.from === "alice")
      .map((packet) => packet.fates[0]?.type)
    expect(delivered).toEqual(["delivered", "dropped", "delivered"])
  })

  it("gets slower but keeps working when the link degrades", () => {
    const { simulation, caller, ping } = commute({ seed: 5 })
    degrade(simulation, "alice", 10_000, profiles.satellite)
    ping(0)
    ping(20_000)
    simulation.run()
    expect(outcomes(caller.events)).toEqual(["response", "response"])
    const [before, after] = simulation.trace
      .filter((packet) => packet.from === "alice")
      .map((packet) => (packet.fates[0]?.at ?? 0) - packet.sentAt)
    expect(after ?? 0).toBeGreaterThan((before ?? 0) + 200)
  })
})
