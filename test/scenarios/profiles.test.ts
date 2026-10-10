import { describe, expect, it } from "vitest"
import { isRequest, type TransportAddress } from "../../src"
import type { LinkConditions } from "../../src/simulation/network/conditions"
import { type ProfileName, profiles } from "../../src/simulation/network/profiles"
import { createSimulation } from "../../src/simulation/simulation"
import { traceStats } from "../../src/simulation/stats"
import { formatTrace } from "../../src/simulation/trace"
import {
  alice,
  bob,
  bytes,
  eventTypes,
  options,
  outcomes,
  parsed,
  register,
  userAgent,
} from "../helpers"

const names = Object.keys(profiles) as ProfileName[]

function ping(access: LinkConditions, seed: number) {
  const simulation = createSimulation({ seed, internet: profiles.fiber })
  const caller = simulation.addNode("alice", alice, userAgent("alice", alice), { access })
  const callee = simulation.addNode("bob", bob, userAgent("bob", bob), { access })
  simulation.command(caller, options(bob))
  simulation.run()
  return { simulation, caller, callee }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

describe("every network profile", () => {
  it.each(names)("ends every ping with one outcome and answers 36 of 40 pings on %s", (name) => {
    let answered = 0
    for (let seed = 1; seed <= 40; seed++) {
      const { simulation, caller, callee } = ping(profiles[name], seed)
      const outcome = outcomes(caller.events)
      const response = outcome[0] === "response"
      const context = `${name} seed ${seed}\n${formatTrace(simulation.trace)}`
      expect(outcome, context).toHaveLength(1)
      expect(!response || eventTypes(callee.events).includes("answered"), context).toBe(true)
      if (response) answered++
    }
    expect(answered).toBeGreaterThanOrEqual(36)
  })

  it.each(["perfect", "lan", "fiber"] as const)("always gets an answer on loss-free %s", (name) => {
    for (let seed = 1; seed <= 40; seed++) {
      expect(outcomes(ping(profiles[name], seed).caller.events)).toEqual(["response"])
    }
  })

  it.each(names)("replays %s identically for the same seed", (name) => {
    expect(ping(profiles[name], 7).simulation.trace).toEqual(
      ping(profiles[name], 7).simulation.trace,
    )
  })

  it("orders the profiles by round-trip time", () => {
    const roundTrip = (name: ProfileName) =>
      median(
        Array.from({ length: 31 }, (_, index) => {
          const { simulation } = ping(profiles[name], index + 1)
          const answer = simulation.trace.find(
            (packet) =>
              packet.from === "bob" && packet.fates.some((fate) => fate.type === "delivered"),
          )
          return answer?.fates.find((fate) => fate.type === "delivered")?.at ?? 0
        }).filter((time) => time > 0),
      )
    const ordered: ProfileName[] = ["lan", "fiber", "wifi", "lte", "mobile3g", "satellite"]
    const times = ordered.map(roundTrip)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(times[0]).toBeLessThan(20)
    expect(times.at(-1)).toBeGreaterThan(1000)
  })
})

describe("path MTU", () => {
  const big = (() => {
    const request = parsed(register)
    if (!isRequest(request)) throw new Error("Expected a request")
    return { ...request, headers: [{ name: "X-Padding", value: "x".repeat(1400) }] }
  })()

  it.each(["lte", "fragmentHostile"] as const)("drops oversized requests on %s", (name) => {
    const simulation = createSimulation({ seed: 1 })
    const caller = simulation.addNode("alice", alice, userAgent("alice", alice), {
      access: profiles[name],
    })
    simulation.addNode("bob", bob, userAgent("bob", bob))
    simulation.command(caller, { type: "send", message: big, to: bob })
    simulation.command(caller, options(bob))
    simulation.run()
    expect(simulation.trace.map((packet) => packet.fates[0]?.type)).toEqual([
      "dropped",
      "delivered",
      "delivered",
    ])
    expect(simulation.trace[0]?.fates[0]).toMatchObject({ reason: "mtu", hop: "uplink" })
  })

  it("enforces the smallest MTU anywhere on the path", () => {
    const simulation = createSimulation({ seed: 1, internet: { mtu: 1300 } })
    simulation.network.attach("alice", alice, { access: { mtu: 1500 } })
    simulation.network.attach("bob", bob)
    simulation.network.send("alice", bob, new Uint8Array(1400), 0)
    simulation.run()
    expect(simulation.trace[0]?.fates).toMatchObject([{ reason: "mtu", hop: "internet" }])
  })
})

describe("queueing", () => {
  function burst(access: LinkConditions, count: number) {
    const simulation = createSimulation({ seed: 1 })
    const sink: TransportAddress = bob
    simulation.network.attach("alice", alice, { access: { up: access, down: {} } })
    simulation.network.attach("bob", sink)
    for (let index = 0; index < count; index++) {
      simulation.network.send("alice", sink, new Uint8Array(972), 0)
    }
    simulation.run()
    return simulation.trace
  }

  it("serializes a burst behind a slow uplink", () => {
    const delays = burst({ bandwidth: 256_000 }, 5).map((packet) => packet.fates[0]?.at)
    expect(delays).toEqual([31.25, 62.5, 93.75, 125, 156.25])
  })

  it("builds seconds of delay with bufferbloat", () => {
    const trace = burst(profiles.bufferbloat, 100)
    expect(traceStats(trace).delivered).toBe(100)
    expect(trace.at(-1)?.fates[0]?.at).toBeGreaterThan(3000)
  })

  it("drops most of a burst on a congested link", () => {
    const stats = traceStats(burst({ bandwidth: 256_000, buffer: 4000 }, 50))
    expect(stats.delivered).toBe(4)
    expect(stats.dropped.congestion).toBe(46)
  })

  it("delivers a burst of small datagrams through a congested profile", () => {
    const simulation = createSimulation({ seed: 1 })
    simulation.network.attach("alice", alice, { access: profiles.congested })
    simulation.network.attach("bob", bob)
    for (let index = 0; index < 10; index++) {
      simulation.network.send("alice", bob, bytes("CRLF keepalive"), index * 100)
    }
    simulation.run()
    expect(traceStats(simulation.trace).dropped.congestion).toBe(0)
  })
})
