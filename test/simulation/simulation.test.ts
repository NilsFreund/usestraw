import { describe, expect, it } from "vitest"
import { type Address, createCore } from "../../src"
import { createSimulation, type SimulationOptions } from "../../src/simulation/simulation"
import { formatTrace } from "../../src/simulation/trace"
import { alice, bob, eventTypes } from "../helpers"

const ua = (address: Address, user: string) => (random: () => number) =>
  createCore({ address, aor: `sip:${user}@example.com`, random })

function setup(options: SimulationOptions) {
  const simulation = createSimulation(options)
  const caller = simulation.addNode("alice", alice, ua(alice, "alice"))
  const callee = simulation.addNode("bob", bob, ua(bob, "bob"))
  return { simulation, caller, callee }
}

function ping(options: SimulationOptions) {
  const scenario = setup(options)
  scenario.simulation.command(scenario.caller, {
    type: "options",
    uri: "sip:bob@example.com",
    to: bob,
  })
  scenario.simulation.run()
  return scenario
}

describe("simulation", () => {
  it("delivers OPTIONS and the automatic 200 OK", () => {
    const { simulation, caller, callee } = ping({ seed: 1, latency: [10, 50] })
    expect(eventTypes(callee.events)).toEqual(["request"])
    expect(caller.events).toMatchObject([{ type: "response", response: { status: 200 } }])
    expect(simulation.trace.map((entry) => `${entry.from}→${entry.to} ${entry.summary}`)).toEqual([
      "alice→bob OPTIONS sip:bob@example.com SIP/2.0",
      "bob→alice SIP/2.0 200 OK",
    ])
    expect(simulation.now).toBeGreaterThanOrEqual(20)
    expect(simulation.now).toBeLessThanOrEqual(100)
  })

  it("times out exactly at Timer F when the network drops everything", () => {
    const { simulation, caller, callee } = ping({ seed: 1, loss: 1 })
    expect(callee.events).toEqual([])
    expect(eventTypes(caller.events)).toEqual(["timeout"])
    expect(simulation.now).toBe(32_000)
    expect(formatTrace(simulation.trace)).toBe(
      "     0ms  alice → bob  OPTIONS sip:bob@example.com SIP/2.0  (lost)",
    )
  })

  it("replays identically for the same seed", () => {
    const first = ping({ seed: 42, latency: [5, 200], loss: 0.3 })
    const second = ping({ seed: 42, latency: [5, 200], loss: 0.3 })
    expect(second.simulation.trace).toEqual(first.simulation.trace)
    expect(second.caller.events).toEqual(first.caller.events)
  })

  it("always ends a ping with exactly one outcome across 500 seeds", () => {
    const outcomes = new Set<string>()
    for (let seed = 1; seed <= 500; seed++) {
      const { simulation, caller, callee } = ping({ seed, latency: [5, 200], loss: 0.3 })
      const outcome = eventTypes(caller.events).join(",")
      const context = `seed ${seed}\n${formatTrace(simulation.trace)}`
      expect(["response", "timeout"], context).toContain(outcome)
      if (outcome === "response") expect(eventTypes(callee.events), context).toEqual(["request"])
      outcomes.add(outcome)
    }
    expect(outcomes).toEqual(new Set(["response", "timeout"]))
  })

  describe("run", () => {
    it("advances the clock to the target time even when idle", () => {
      const { simulation, caller } = setup({ seed: 1 })
      simulation.run(5000)
      expect(simulation.now).toBe(5000)
      simulation.command(caller, { type: "options", uri: "sip:bob@example.com", to: bob })
      expect(simulation.trace[0]?.sentAt).toBe(5000)
    })

    it("stops before events after the target time", () => {
      const { simulation, caller } = setup({ seed: 1, loss: 1 })
      simulation.command(caller, { type: "options", uri: "sip:bob@example.com", to: bob })
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
      simulation.command(caller, { type: "options", uri: "sip:bob@example.com", to: bob })
      simulation.run()
      expect(eventTypes(caller.events)).toEqual(["response"])
    })

    it("fails loudly when the simulation does not settle", () => {
      const { simulation, caller } = setup({ seed: 1, maxSteps: 1 })
      simulation.command(caller, { type: "options", uri: "sip:bob@example.com", to: bob })
      expect(() => simulation.run()).toThrow("Simulation did not settle after 1 steps")
    })
  })

  describe("nodes", () => {
    it("rejects two nodes on the same address", () => {
      const { simulation } = setup({ seed: 1 })
      expect(() => simulation.addNode("eve", alice, ua(alice, "eve"))).toThrow(
        "Address UDP:192.0.2.10:5060 is already taken",
      )
    })

    it("rejects commands for nodes of another simulation", () => {
      const { caller } = setup({ seed: 1 })
      const other = setup({ seed: 1 }).simulation
      expect(() =>
        other.command(caller, { type: "options", uri: "sip:bob@example.com", to: bob }),
      ).toThrow("Unknown node alice")
    })

    it("drops packets to addresses without a node", () => {
      const { simulation, caller } = setup({ seed: 1 })
      const nowhere: Address = { transport: "UDP", host: "192.0.2.99", port: 5060 }
      simulation.command(caller, { type: "options", uri: "sip:x@example.com", to: nowhere })
      simulation.run()
      expect(simulation.trace[0]?.to).toBe("UDP:192.0.2.99:5060")
      expect(eventTypes(caller.events)).toEqual(["timeout"])
    })
  })
})
