import { describe, expect, it } from "vitest"
import type { CoreEvent } from "../../src"
import { createSimulation } from "../../src/simulation/simulation"
import { formatTrace } from "../../src/simulation/trace"
import { alice, bob, options, userAgent } from "../helpers"

function finals(events: readonly CoreEvent[]): CoreEvent[] {
  return events.filter(
    (event) =>
      (event.type === "response" && event.response.status >= 200) || event.type === "timeout",
  )
}

describe("bit errors on the wire", () => {
  it("reports damaged datagrams as invalid and still ends every ping", () => {
    let invalid = 0
    let damaged = 0
    for (let seed = 1; seed <= 300; seed++) {
      const simulation = createSimulation({ seed, internet: { corrupt: 0.5 } })
      const caller = simulation.addNode("alice", alice, userAgent("alice", alice))
      const callee = simulation.addNode("bob", bob, userAgent("bob", bob))
      simulation.command(caller, options(bob))
      simulation.run()
      const context = `seed ${seed}\n${formatTrace(simulation.trace)}`
      expect(finals(caller.events), context).toHaveLength(1)
      invalid += [...caller.events, ...callee.events].filter(
        ({ type }) => type === "invalid",
      ).length
      damaged += simulation.trace
        .flatMap((packet) => packet.fates)
        .filter((fate) => fate.type === "delivered" && fate.corrupted).length
    }
    expect(invalid).toBeGreaterThan(damaged / 2)
    expect(invalid).toBeLessThanOrEqual(damaged)
  })
})
