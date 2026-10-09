import { describe, expect, it } from "vitest"
import type { Address } from "../../src"
import { latency } from "../../src/simulation/network/conditions"
import type { Fate } from "../../src/simulation/network/types"
import { degrade, flapping, handover, outage, partition } from "../../src/simulation/scenarios"
import { createSimulation } from "../../src/simulation/simulation"
import { alice, bob, bytes } from "../helpers"

const probe = bytes("PROBE\r\n\r\n")

function world() {
  const simulation = createSimulation({ seed: 1, internet: { latency: latency.fixed(20) } })
  simulation.network.attach("alice", alice)
  simulation.network.attach("bob", bob)
  const pingAt = (time: number) =>
    simulation.at(time, () => simulation.network.send("alice", bob, probe, time))
  const firstFates = () =>
    simulation.trace
      .filter((packet) => packet.from === "alice")
      .map((packet) => fateLabel(packet.fates[0]))
  return { simulation, pingAt, firstFates, address: () => simulation.network.addressOf("alice") }
}

function fateLabel(fate: Fate | undefined): string {
  if (!fate) return "in flight"
  return fate.type === "delivered" ? "delivered" : `${fate.reason}@${fate.hop}`
}

describe("scenario helpers", () => {
  it("takes a host offline for the duration of an outage", () => {
    const { simulation, pingAt, firstFates } = world()
    outage(simulation, "bob", 1000, 2000)
    for (const time of [500, 1500, 2970, 3000]) pingAt(time)
    simulation.run()
    expect(firstFates()).toEqual(["delivered", "outage@downlink", "outage@downlink", "delivered"])
  })

  it("keeps a host offline through overlapping outages", () => {
    const { simulation, pingAt, firstFates } = world()
    flapping(simulation, "bob", { from: 0, every: 1000, duration: 1500, count: 2 })
    for (const time of [1700, 2300, 2600]) pingAt(time)
    simulation.run()
    expect(firstFates()).toEqual(["outage@downlink", "outage@downlink", "delivered"])
  })

  it("judges an outage when the packet reaches the link, not when it was sent", () => {
    const { simulation, pingAt, firstFates } = world()
    outage(simulation, "bob", 1000, 2000)
    pingAt(985)
    pingAt(2985)
    simulation.run()
    expect(firstFates()).toEqual(["outage@downlink", "delivered"])
  })

  it("repeats outages while flapping", () => {
    const { simulation, pingAt, firstFates } = world()
    flapping(simulation, "bob", { from: 0, every: 1000, duration: 500, count: 3 })
    for (const time of [100, 600, 1100, 1600, 2100, 2600, 3100]) pingAt(time)
    simulation.run()
    expect(firstFates()).toEqual([
      "outage@downlink",
      "delivered",
      "outage@downlink",
      "delivered",
      "outage@downlink",
      "delivered",
      "delivered",
    ])
  })

  it("cuts the route between two sites in both directions during a partition", () => {
    const { simulation, pingAt, firstFates } = world()
    partition(simulation, ["alice", "bob"], 1000, 1000)
    for (const time of [500, 1500, 2500]) pingAt(time)
    simulation.run()
    expect(firstFates()).toEqual(["delivered", "outage@internet", "delivered"])
  })

  it("restores custom route conditions after a partition heals", () => {
    const { simulation, pingAt } = world()
    simulation.network.setRoute("alice", "bob", { latency: latency.fixed(300) })
    partition(simulation, ["alice", "bob"], 1000, 1000)
    pingAt(5000)
    simulation.run()
    const [packet] = simulation.trace.filter((entry) => entry.from === "alice")
    expect((packet?.fates[0]?.at ?? 0) - (packet?.sentAt ?? 0)).toBe(300)
  })

  it("moves a host to a new address at the handover time", () => {
    const { simulation, address } = world()
    const lte: Address = { ...alice, host: "100.64.12.34" }
    handover(simulation, "alice", 1000, lte)
    simulation.run(999)
    expect(address()).toEqual(alice)
    simulation.run(1000)
    expect(address()).toEqual(lte)
  })

  it("passes NAT and access options along with a handover", () => {
    const { simulation, address } = world()
    simulation.network.addNat("carrier", { host: "198.51.100.1" })
    const cgnat: Address = { ...alice, host: "100.64.0.9" }
    handover(simulation, "alice", 10, cgnat, {
      nat: "carrier",
      access: { latency: latency.fixed(40) },
    })
    simulation.run()
    expect(address()).toEqual(cgnat)
  })

  it("replaces the access link when degrading", () => {
    const { simulation, pingAt } = world()
    degrade(simulation, "bob", 1000, { latency: latency.fixed(300) })
    pingAt(0)
    pingAt(2000)
    simulation.run()
    const arrivals = simulation.trace
      .filter((packet) => packet.from === "alice")
      .map((packet) => (packet.fates[0]?.at ?? 0) - packet.sentAt)
    expect(arrivals).toEqual([20, 320])
  })
})
