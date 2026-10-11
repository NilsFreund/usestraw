import { describe, expect, it } from "vitest"
import type { TransportAddress } from "../../../src/core"
import { latency } from "../../../src/simulation/network/conditions"
import {
  createForwarding,
  type PacketState,
  type Transit,
} from "../../../src/simulation/network/forwarding"
import { createHosts } from "../../../src/simulation/network/hosts"
import { createNats } from "../../../src/simulation/network/nats"
import { createRoutes } from "../../../src/simulation/network/routes"
import type { Hop } from "../../../src/simulation/network/types"
import { createStreams } from "../../../src/simulation/random"
import { createAgenda } from "../../../src/support/agenda"
import { alice, bob, bytes } from "../../helpers"

type World = ReturnType<typeof fabric>

function fabric() {
  const stream = createStreams(1)
  const hosts = createHosts(stream)
  const nats = createNats(stream)
  const routes = createRoutes({ latency: latency.fixed(20) }, stream)
  const agenda = createAgenda<Transit>()
  return { hosts, nats, routes, agenda, advance: createForwarding({ hosts, nats, routes, agenda }) }
}

function transit(destination: TransportAddress = bob): Transit {
  const packet: PacketState = {
    id: 1,
    sentAt: 0,
    from: "alice",
    to: "bob",
    size: 100,
    summary: "ping",
    copies: 1,
    fates: [],
  }
  return {
    packet,
    sender: "alice",
    receiver: "",
    source: alice,
    destination,
    data: bytes("ping"),
    corrupted: false,
    hop: "uplink",
    origin: undefined,
  }
}

function runUntil(world: World, until: number): [number, Hop][] {
  const hops: [number, Hop][] = []
  for (
    let next = world.agenda.next();
    next !== undefined && next <= until;
    next = world.agenda.next()
  ) {
    const item = world.agenda.take(next)
    if (!item) break
    hops.push([next, item.hop])
    world.advance(item, next)
  }
  return hops
}

function walk(world: World, start: Transit): [number, Hop][] {
  world.agenda.push(0, start)
  return runUntil(world, Number.POSITIVE_INFINITY)
}

describe("createForwarding", () => {
  it("walks a public packet through the timed hops and delivers it", () => {
    const world = fabric()
    world.hosts.add("alice", alice, { access: { latency: latency.fixed(5) } })
    world.hosts.add("bob", bob, { access: { latency: latency.fixed(3) } })
    const start = transit()
    expect(walk(world, start)).toEqual([
      [0, "uplink"],
      [5, "egress"],
      [25, "ingress"],
      [28, "arrival"],
    ])
    expect(start.packet.fates).toEqual([
      { type: "delivered", at: 28, host: "bob", corrupted: false },
    ])
  })

  it("returns the delivery from the arrival hop only", () => {
    const world = fabric()
    world.hosts.add("alice", alice, {})
    world.hosts.add("bob", bob, {})
    const arrival = { ...transit(), receiver: "bob", hop: "arrival" as const }
    expect(world.advance(transit(), 0)).toBeUndefined()
    expect(world.advance(arrival, 0)).toEqual({ host: "bob", from: alice, data: bytes("ping") })
  })

  it("records the hop where a packet was dropped", () => {
    const world = fabric()
    world.hosts.add("alice", alice, {})
    const start = transit()
    walk(world, start)
    expect(start.packet.fates).toEqual([
      { type: "dropped", at: 20, reason: "unroutable", hop: "ingress" },
    ])
  })

  it("drops packets on the uplink when the sender goes offline meanwhile", () => {
    const world = fabric()
    world.hosts.add("alice", alice, { access: { latency: latency.fixed(50) } })
    world.hosts.add("bob", bob, {})
    const start = transit()
    world.agenda.push(0, start)
    runUntil(world, 0)
    world.hosts.disconnect("alice")
    runUntil(world, Number.POSITIVE_INFINITY)
    expect(start.packet.fates).toEqual([
      { type: "dropped", at: 50, reason: "outage", hop: "egress" },
    ])
  })

  it("drops packets on the downlink when the receiver goes offline meanwhile", () => {
    const world = fabric()
    world.hosts.add("alice", alice, {})
    world.hosts.add("bob", bob, { access: { latency: latency.fixed(50) } })
    const start = transit()
    world.agenda.push(0, start)
    runUntil(world, 30)
    world.hosts.disconnect("bob")
    runUntil(world, Number.POSITIVE_INFINITY)
    expect(start.packet.fates).toEqual([
      { type: "dropped", at: 70, reason: "outage", hop: "arrival" },
    ])
  })

  it("leaves through the NAT the packet was sent behind, even after a handover", () => {
    const world = fabric()
    world.nats.add("home", { host: "203.0.113.1", ports: "sequential" })
    world.nats.add("carrier", { host: "198.51.100.1", ports: "sequential" })
    world.hosts.add("alice", alice, { nat: "carrier" })
    world.hosts.add("bob", bob, {})
    world.agenda.push(0, { ...transit(), origin: "home", hop: "egress" })
    runUntil(world, 0)
    expect(world.agenda.take(Number.POSITIVE_INFINITY)?.source).toEqual({
      transport: "UDP",
      host: "203.0.113.1",
      port: 49152,
    })
  })

  it("counts duplicated copies on the packet", () => {
    const world = fabric()
    world.hosts.add("alice", alice, { access: { up: { duplicate: 1 }, down: {} } })
    world.hosts.add("bob", bob, {})
    const start = transit()
    walk(world, start)
    expect(start.packet.copies).toBe(2)
    expect(start.packet.fates).toHaveLength(2)
  })

  it("keeps the corruption mark across later hops", () => {
    const world = fabric()
    world.hosts.add("alice", alice, { access: { up: { corrupt: 1 }, down: {} } })
    world.hosts.add("bob", bob, {})
    const start = transit()
    walk(world, start)
    expect(start.packet.fates).toMatchObject([{ type: "delivered", corrupted: true }])
  })
})
