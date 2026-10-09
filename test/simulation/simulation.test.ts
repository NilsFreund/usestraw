import { describe, expect, it } from "vitest"
import type { Address } from "../../src"
import { latency, loss } from "../../src/simulation/network/conditions"
import { createSimulation, type SimulationOptions } from "../../src/simulation/simulation"
import { formatTrace } from "../../src/simulation/trace"
import { alice, bob, bytes, eventTypes, options, outcomes, userAgent } from "../helpers"

function setup(simulationOptions: SimulationOptions) {
  const simulation = createSimulation(simulationOptions)
  const caller = simulation.addNode("alice", alice, userAgent("alice", alice))
  const callee = simulation.addNode("bob", bob, userAgent("bob", bob))
  return { simulation, caller, callee }
}

function ping(simulationOptions: SimulationOptions) {
  const scenario = setup(simulationOptions)
  scenario.simulation.command(scenario.caller, options(bob))
  scenario.simulation.run()
  return scenario
}

const lossy = { latency: latency.uniform(5, 200), loss: loss.random(0.3) }

describe("createSimulation", () => {
  it("delivers OPTIONS and the automatic 200 OK", () => {
    const { simulation, caller, callee } = ping({
      seed: 1,
      internet: { latency: latency.uniform(10, 50) },
    })
    expect(eventTypes(callee.events)).toEqual(["request"])
    expect(caller.events).toMatchObject([{ type: "response", response: { status: 200 } }])
    expect(
      simulation.trace.map((packet) => `${packet.from}→${packet.to} ${packet.summary}`),
    ).toEqual(["alice→bob OPTIONS sip:bob@example.com SIP/2.0", "bob→alice SIP/2.0 200 OK"])
    expect(simulation.now).toBeGreaterThanOrEqual(20)
    expect(simulation.now).toBeLessThanOrEqual(100)
  })

  it("times out exactly at Timer F when the internet drops everything", () => {
    const { simulation, caller, callee } = ping({ seed: 1, internet: { loss: loss.random(1) } })
    expect(callee.events).toEqual([])
    expect(eventTypes(caller.events)).toEqual(["timeout"])
    expect(simulation.now).toBe(32_000)
    expect(formatTrace(simulation.trace)).toBe(
      "     0ms  alice → bob  OPTIONS sip:bob@example.com SIP/2.0  (lost)",
    )
  })

  it("replays identically for the same seed", () => {
    const first = ping({ seed: 42, internet: lossy })
    const second = ping({ seed: 42, internet: lossy })
    expect(second.simulation.trace).toEqual(first.simulation.trace)
    expect(second.caller.events).toEqual(first.caller.events)
  })

  it("always ends a ping with exactly one outcome across 500 seeds", () => {
    const seen = new Set<string>()
    for (let seed = 1; seed <= 500; seed++) {
      const { simulation, caller, callee } = ping({ seed, internet: lossy })
      const outcome = outcomes(caller.events).join(",")
      const context = `seed ${seed}\n${formatTrace(simulation.trace)}`
      expect(["response", "timeout"], context).toContain(outcome)
      if (outcome === "response") expect(eventTypes(callee.events), context).toEqual(["request"])
      seen.add(outcome)
    }
    expect(seen).toEqual(new Set(["response", "timeout"]))
  })

  it("exposes the network and its trace", () => {
    const { simulation } = setup({ seed: 1 })
    expect(simulation.trace).toBe(simulation.network.trace)
  })

  describe("run", () => {
    it("advances the clock to the target time even when idle", () => {
      const { simulation, caller } = setup({ seed: 1 })
      simulation.run(5000)
      expect(simulation.now).toBe(5000)
      simulation.command(caller, options(bob))
      expect(simulation.trace[0]?.sentAt).toBe(5000)
    })

    it("stops before events after the target time", () => {
      const { simulation, caller } = setup({ seed: 1, internet: { loss: loss.random(1) } })
      simulation.command(caller, options(bob))
      simulation.run(10_000)
      expect(caller.events).toEqual([])
      simulation.run()
      expect(eventTypes(caller.events)).toEqual(["timeout"])
    })

    it("stays at the current time without a target or events", () => {
      const { simulation } = setup({ seed: 1 })
      simulation.run()
      expect(simulation.now).toBe(0)
    })

    it("settles when the last event happens exactly at maxSteps", () => {
      const { simulation, caller } = setup({ seed: 1, maxSteps: 2 })
      simulation.command(caller, options(bob))
      simulation.run()
      expect(eventTypes(caller.events)).toEqual(["response"])
    })

    it("fails loudly when the simulation does not settle", () => {
      const { simulation, caller } = setup({ seed: 1, maxSteps: 1 })
      simulation.command(caller, options(bob))
      expect(() => simulation.run()).toThrow("Simulation did not settle after 1 steps")
    })
  })

  describe("timeline", () => {
    it("runs actions at their time before packets of the same moment", () => {
      const { simulation, caller } = setup({ seed: 1 })
      const log: number[] = []
      simulation.at(300, () => log.push(simulation.now))
      simulation.at(100, () => simulation.command(caller, options(bob)))
      simulation.run()
      expect(log).toEqual([300])
      expect(simulation.trace[0]?.sentAt).toBe(100)
    })

    it("runs actions scheduled for the current moment by other actions", () => {
      const { simulation } = setup({ seed: 1 })
      const log: string[] = []
      simulation.at(10, () => simulation.at(10, () => log.push("nested")))
      simulation.run()
      expect(log).toEqual(["nested"])
    })

    it("rejects actions in the past", () => {
      const { simulation } = setup({ seed: 1 })
      simulation.run(1000)
      expect(() => simulation.at(999, () => {})).toThrow(
        new RangeError("Cannot schedule at 999ms, the clock is at 1000ms"),
      )
    })
  })

  describe("nodes", () => {
    it("rejects taken names and addresses", () => {
      const { simulation } = setup({ seed: 1 })
      expect(() =>
        simulation.addNode("alice", { ...alice, port: 9 }, userAgent("x", alice)),
      ).toThrow("Host alice already exists")
      expect(() => simulation.addNode("eve", alice, userAgent("eve", alice))).toThrow(
        "already taken by alice",
      )
    })

    it("rejects commands for nodes of another simulation", () => {
      const { caller } = setup({ seed: 1 })
      const other = setup({ seed: 1 }).simulation
      expect(() => other.command(caller, options(bob))).toThrow("Unknown node alice")
    })

    it("drops packets to addresses without a node", () => {
      const { simulation, caller } = setup({ seed: 1 })
      const nowhere: Address = { transport: "UDP", host: "192.0.2.99", port: 5060 }
      simulation.command(caller, options(nowhere, "sip:x@example.com"))
      simulation.run()
      expect(simulation.trace[0]?.to).toBe("UDP:192.0.2.99:5060")
      expect(simulation.trace[0]?.fates).toMatchObject([{ reason: "unroutable" }])
      expect(eventTypes(caller.events)).toEqual(["timeout"])
    })

    it("ignores deliveries to plain network hosts without a core", () => {
      const { simulation } = setup({ seed: 1 })
      const sink: Address = { transport: "UDP", host: "192.0.2.50", port: 5060 }
      simulation.network.attach("sink", sink)
      simulation.network.send("alice", sink, bytes("x"), 0)
      simulation.run()
      expect(simulation.trace[0]?.fates).toMatchObject([{ type: "delivered", host: "sink" }])
    })

    it("does not attach a host when its core cannot be created", () => {
      const { simulation } = setup({ seed: 1 })
      const carol: Address = { transport: "UDP", host: "192.0.2.30", port: 5060 }
      const broken = () => {
        throw new TypeError("bad core")
      }
      expect(() => simulation.addNode("carol", carol, broken)).toThrow("bad core")
      expect(() => simulation.addNode("carol", carol, userAgent("carol", carol))).not.toThrow()
    })

    it("follows the network address after a move", () => {
      const { simulation, caller } = setup({ seed: 1 })
      const moved: Address = { ...alice, host: "192.0.2.77" }
      simulation.network.move("alice", moved)
      expect(caller.address).toEqual(moved)
    })
  })
})
