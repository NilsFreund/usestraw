import { describe, expect, it } from "vitest"
import { latency, loss } from "../../../src/simulation/network/conditions"
import { createRoutes } from "../../../src/simulation/network/routes"
import { createStreams } from "../../../src/simulation/random"

const internet = { latency: latency.fixed(20) }
const routes = () => createRoutes(internet, createStreams(1))

describe("createRoutes", () => {
  it("uses the internet conditions and keeps one stateful segment per direction", () => {
    const table = routes()
    const forward = table.segment("alice", "bob")
    expect(forward.conditions).toBe(internet)
    expect(table.segment("alice", "bob")).toBe(forward)
    expect(table.segment("bob", "alice")).not.toBe(forward)
  })

  it("overrides a single direction", () => {
    const table = routes()
    table.set("alice", "bob", { down: true })
    expect(table.segment("alice", "bob").conditions).toEqual({ down: true })
    expect(table.segment("bob", "alice").conditions).toBe(internet)
  })

  it("keeps the queue of a route when its conditions change", () => {
    const table = routes()
    table.set("alice", "bob", { bandwidth: 8000 })
    table.segment("alice", "bob").traverse(new Uint8Array(), 1000, 0)
    table.set("alice", "bob", { bandwidth: 8000 })
    expect(table.segment("alice", "bob").traverse(new Uint8Array(), 1000, 0)).toMatchObject({
      copies: [{ at: 2000 }],
    })
  })

  it("restores the internet conditions", () => {
    const table = routes()
    table.set("alice", "bob", { down: true })
    table.set("alice", "bob", undefined)
    expect(table.segment("alice", "bob").conditions).toBe(internet)
  })

  it("counts blocks per direction", () => {
    const table = routes()
    table.block("alice", "bob")
    table.block("alice", "bob")
    table.unblock("alice", "bob")
    expect([table.blocked("alice", "bob"), table.blocked("bob", "alice")]).toEqual([true, false])
    table.unblock("alice", "bob")
    expect(table.blocked("alice", "bob")).toBe(false)
  })

  it("ignores unblocking a route that is not blocked", () => {
    const table = routes()
    table.unblock("alice", "bob")
    table.block("alice", "bob")
    expect(table.blocked("alice", "bob")).toBe(true)
  })

  it("keeps the route conditions while blocked", () => {
    const table = routes()
    table.set("alice", "bob", { latency: latency.fixed(80) })
    table.block("alice", "bob")
    expect(table.segment("alice", "bob").conditions).toEqual({ latency: latency.fixed(80) })
  })

  it("validates internet and override conditions", () => {
    expect(() => createRoutes({ loss: loss.random(2) }, createStreams(1))).toThrow(RangeError)
    expect(() => routes().set("a", "b", { mtu: 0 })).toThrow(RangeError)
  })
})
