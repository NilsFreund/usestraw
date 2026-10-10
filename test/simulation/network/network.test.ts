import { describe, expect, it } from "vitest"
import type { TransportAddress } from "../../../src"
import { latency, loss } from "../../../src/simulation/network/conditions"
import { type NatType, natTypes } from "../../../src/simulation/network/nat/types"
import { createNetwork, type Network } from "../../../src/simulation/network/network"
import { alice, bob, bytes } from "../../helpers"
import { settle } from "../support"

const phone: TransportAddress = { transport: "UDP", host: "192.168.1.10", port: 5060 }
const laptop: TransportAddress = { transport: "UDP", host: "192.168.1.11", port: 5060 }
const ping = bytes("OPTIONS sip:bob@example.com SIP/2.0\r\n\r\n")

function network(): Network {
  return createNetwork({ seed: 1, internet: { latency: latency.fixed(20) } })
}

describe("createNetwork", () => {
  it("delivers between public hosts with the sender address as source", () => {
    const net = network()
    net.attach("alice", alice)
    net.attach("bob", bob)
    net.send("alice", bob, ping, 0)
    expect(settle(net)).toEqual([{ at: 20, host: "bob", from: alice, data: ping }])
  })

  it("records every packet with its fate", () => {
    const net = network()
    net.attach("alice", alice)
    net.attach("bob", bob)
    net.send("alice", bob, ping, 5)
    settle(net)
    expect(net.trace).toEqual([
      {
        id: 1,
        sentAt: 5,
        from: "alice",
        to: "bob",
        size: ping.length + 28,
        summary: "OPTIONS sip:bob@example.com SIP/2.0",
        copies: 1,
        fates: [{ type: "delivered", at: 25, host: "bob", corrupted: false }],
      },
    ])
  })

  it("does nothing before packets are due", () => {
    const net = network()
    net.attach("alice", alice)
    net.attach("bob", bob)
    net.send("alice", bob, ping, 0)
    expect(net.step(0)).toEqual([])
    expect(net.nextEvent()).toBe(20)
  })

  describe("NAT", () => {
    function home(type: NatType = "portRestrictedCone") {
      const net = network()
      net.addNat("home", { host: "203.0.113.1", ports: "sequential", ...natTypes[type] })
      net.attach("phone", phone, { nat: "home" })
      net.attach("laptop", laptop, { nat: "home" })
      net.attach("bob", bob)
      return net
    }

    const mapped: TransportAddress = { transport: "UDP", host: "203.0.113.1", port: 49152 }

    it("rewrites the source and lets replies back in", () => {
      const net = home()
      net.send("phone", bob, ping, 0)
      expect(settle(net)).toMatchObject([{ host: "bob", from: mapped }])
      net.send("bob", mapped, ping, 100)
      expect(settle(net)).toMatchObject([{ host: "phone", from: bob }])
    })

    it("drops unsolicited packets at the NAT", () => {
      const net = home()
      net.send("bob", mapped, ping, 0)
      settle(net)
      expect(net.trace[0]?.fates).toEqual([
        { type: "dropped", at: 20, reason: "nat", hop: "ingress" },
      ])
    })

    it("delivers between neighbors on the same LAN without translation or internet", () => {
      const net = home()
      net.send("phone", laptop, ping, 0)
      expect(settle(net)).toEqual([{ at: 0, host: "laptop", from: phone, data: ping }])
    })

    it("hairpins to a neighbor's public mapping inside the NAT on a full cone", () => {
      const net = home("fullCone")
      net.send("laptop", bob, ping, 0)
      settle(net)
      net.send("phone", mapped, ping, 100)
      expect(settle(net)).toEqual([
        {
          at: 100,
          host: "laptop",
          from: { transport: "UDP", host: "203.0.113.1", port: 49153 },
          data: ping,
        },
      ])
    })

    it("filters hairpinned packets like any other inbound packet", () => {
      const net = home()
      net.send("laptop", bob, ping, 0)
      settle(net)
      net.send("phone", mapped, ping, 100)
      expect(settle(net)).toEqual([])
      expect(net.trace.at(-1)?.fates).toEqual([
        { type: "dropped", at: 100, reason: "nat", hop: "ingress" },
      ])
    })

    it("forgets mappings when the NAT reboots", () => {
      const net = home()
      net.send("phone", bob, ping, 0)
      settle(net)
      net.resetNat("home")
      net.send("bob", mapped, ping, 100)
      settle(net)
      expect(net.trace.at(-1)?.fates).toMatchObject([{ reason: "nat" }])
    })

    it("cannot route to a private address from the internet", () => {
      const net = home()
      net.send("bob", phone, ping, 0)
      settle(net)
      expect(net.trace[0]?.fates).toMatchObject([{ reason: "unroutable", hop: "ingress" }])
    })

    it("rejects unknown NATs when attaching or moving", () => {
      const net = home()
      expect(() => net.attach("tv", laptop, { nat: "office" })).toThrow("Unknown NAT office")
      expect(() => net.move("phone", laptop, { nat: "office" })).toThrow("Unknown NAT office")
    })
  })

  describe("carrier-grade NAT", () => {
    function carrier() {
      const net = network()
      net.addNat("carrier", { host: "198.51.100.1", ports: "sequential", ...natTypes.fullCone })
      net.addNat("home", {
        host: "100.64.0.7",
        behind: "carrier",
        ports: "sequential",
        ...natTypes.fullCone,
      })
      net.addNat("neighbor", {
        host: "100.64.0.8",
        behind: "carrier",
        ports: "sequential",
        ...natTypes.fullCone,
      })
      net.attach("phone", phone, { nat: "home" })
      net.attach("tablet", phone, { nat: "neighbor" })
      net.attach("bob", bob)
      return net
    }

    it("translates through both NATs on the way out and back in", () => {
      const net = carrier()
      net.send("phone", bob, ping, 0)
      const [outbound] = settle(net)
      expect(outbound?.from).toEqual({ transport: "UDP", host: "198.51.100.1", port: 49152 })
      net.send("bob", outbound?.from ?? bob, ping, 100)
      expect(settle(net)).toMatchObject([{ host: "phone", from: bob }])
    })

    it("connects subscribers of the same carrier without the internet", () => {
      const net = carrier()
      net.send("tablet", { transport: "UDP", host: "100.64.0.7", port: 1 }, ping, 0)
      expect(settle(net)).toEqual([])
      net.send("phone", { transport: "UDP", host: "100.64.0.8", port: 49152 }, ping, 10)
      expect(settle(net)).toEqual([
        {
          at: 10,
          host: "tablet",
          from: { transport: "UDP", host: "100.64.0.7", port: 49152 },
          data: ping,
        },
      ])
      expect(net.trace[0]?.fates).toEqual([
        { type: "dropped", at: 0, reason: "nat", hop: "ingress" },
      ])
    })

    it("hairpins inside the subscriber NAT without involving the carrier", () => {
      const net = carrier()
      net.attach("laptop", laptop, { nat: "home" })
      net.send("laptop", bob, ping, 0)
      settle(net)
      net.send("phone", { transport: "UDP", host: "100.64.0.7", port: 49152 }, ping, 100)
      expect(settle(net)).toMatchObject([
        { at: 100, host: "laptop", from: { host: "100.64.0.7", port: 49153 } },
      ])
    })
  })

  describe("access links and routes", () => {
    it("drops on the sender uplink and the receiver downlink independently", () => {
      const net = network()
      net.attach("alice", alice, { access: { up: { loss: loss.random(1) }, down: {} } })
      net.attach("bob", bob)
      net.send("alice", bob, ping, 0)
      net.send("bob", alice, ping, 0)
      expect(settle(net)).toMatchObject([{ host: "alice" }])
      expect(net.trace[0]?.fates).toMatchObject([{ reason: "loss", hop: "uplink" }])
    })

    it("drops everything while a host is offline", () => {
      const net = network()
      net.attach("alice", alice)
      net.attach("bob", bob)
      net.disconnect("bob")
      net.disconnect("bob")
      net.reconnect("bob")
      net.send("alice", bob, ping, 0)
      net.send("bob", alice, ping, 0)
      settle(net)
      expect(net.trace.map((packet) => packet.fates[0])).toMatchObject([
        { reason: "outage", hop: "downlink" },
        { reason: "outage", hop: "uplink" },
      ])
    })

    it("applies route overrides between sites", () => {
      const net = network()
      net.attach("alice", alice)
      net.attach("bob", bob)
      net.setRoute("alice", "bob", { down: true })
      net.send("alice", bob, ping, 0)
      net.send("bob", alice, ping, 0)
      settle(net)
      expect(net.trace.map((packet) => packet.fates[0]?.type)).toEqual(["dropped", "delivered"])
    })

    it("keeps a route blocked until every block is lifted, without touching its conditions", () => {
      const net = network()
      net.attach("alice", alice)
      net.attach("bob", bob)
      net.setRoute("alice", "bob", { latency: latency.fixed(70) })
      net.block("alice", "bob")
      net.block("alice", "bob")
      net.unblock("alice", "bob")
      net.send("alice", bob, ping, 0)
      net.step(0)
      net.unblock("alice", "bob")
      net.send("alice", bob, ping, 100)
      settle(net)
      expect(net.trace.map((packet) => packet.fates[0])).toMatchObject([
        { type: "dropped", reason: "outage", hop: "internet" },
        { type: "delivered", at: 170 },
      ])
    })

    it("resolves hosts behind a NAT to their site for routes and blocks", () => {
      const net = network()
      net.addNat("carrier", { host: "198.51.100.1" })
      net.addNat("home", { host: "100.64.0.7", behind: "carrier" })
      net.attach("phone", phone, { nat: "home" })
      net.attach("bob", bob)
      net.block("phone", "bob")
      net.send("phone", bob, ping, 0)
      net.step(0)
      net.unblock("carrier", "bob")
      net.setRoute("home", "bob", { latency: latency.fixed(90) })
      net.send("phone", bob, ping, 100)
      settle(net)
      expect(net.trace.map((packet) => packet.fates[0])).toMatchObject([
        { type: "dropped", reason: "outage" },
        { type: "delivered", at: 190 },
      ])
    })

    it("rejects routes and blocks for unknown names", () => {
      const net = network()
      net.attach("alice", alice)
      expect(() => net.setRoute("alice", "bobb", {})).toThrow("Unknown host or NAT bobb")
      expect(() => net.block("nobody", "alice")).toThrow("Unknown host or NAT nobody")
    })

    it("replaces the access link at runtime", () => {
      const net = network()
      net.attach("alice", alice)
      net.attach("bob", bob)
      net.setAccess("bob", { latency: latency.fixed(100) })
      net.send("alice", bob, ping, 0)
      expect(settle(net)).toMatchObject([{ at: 120 }])
    })
  })

  describe("mobility", () => {
    it("drops packets on the downlink when the receiver moves away meanwhile", () => {
      const net = network()
      net.attach("alice", alice, { access: { up: {}, down: { latency: latency.fixed(50) } } })
      net.attach("bob", bob)
      net.send("bob", alice, ping, 0)
      net.step(0)
      net.step(20)
      net.move("alice", { ...alice, host: "192.0.2.99" })
      settle(net)
      expect(net.trace[0]?.fates).toEqual([
        { type: "dropped", at: 70, reason: "unroutable", hop: "arrival" },
      ])
    })

    it("drops packets in flight to the old address after a move", () => {
      const net = network()
      net.attach("alice", alice)
      net.attach("bob", bob)
      net.send("bob", alice, ping, 0)
      net.step(0)
      const moved: TransportAddress = { ...alice, host: "192.0.2.99" }
      net.move("alice", moved)
      expect(net.addressOf("alice")).toEqual(moved)
      settle(net)
      expect(net.trace[0]?.fates).toMatchObject([{ reason: "unroutable" }])
      net.send("bob", moved, ping, 50)
      expect(settle(net)).toMatchObject([{ host: "alice" }])
    })
  })

  describe("configuration conflicts", () => {
    it("keeps host and NAT names apart", () => {
      const net = network()
      net.addNat("home", { host: "203.0.113.1" })
      net.attach("alice", alice)
      expect(() => net.attach("home", bob)).toThrow("Name home is already taken by a NAT")
      expect(() => net.addNat("alice", { host: "203.0.113.2" })).toThrow(
        "Name alice is already taken by a host",
      )
    })

    it("keeps hosts off the public address of a NAT and vice versa", () => {
      const net = network()
      net.addNat("edge", { host: "203.0.113.1" })
      net.attach("alice", alice)
      expect(() => net.attach("server", { ...bob, host: "203.0.113.1" })).toThrow(
        "Host 203.0.113.1 is the public address of NAT edge",
      )
      expect(() => net.move("alice", { ...alice, host: "203.0.113.1" })).toThrow(
        "Host 203.0.113.1 is the public address of NAT edge",
      )
      expect(() => net.addNat("other", { host: alice.host })).toThrow(
        `Public host ${alice.host} is already used by a host`,
      )
    })

    it("checks conflicts inside the site a host moves into", () => {
      const net = network()
      net.addNat("carrier", { host: "198.51.100.1" })
      net.addNat("home", { host: "100.64.0.7", behind: "carrier" })
      net.attach("phone", phone, { nat: "home" })
      expect(() => net.move("phone", { ...phone, host: "100.64.0.7" }, { nat: "carrier" })).toThrow(
        "is the public address of NAT home",
      )
      net.move("phone", laptop)
      expect(net.addressOf("phone")).toEqual(laptop)
    })

    it("moves a host out of its NAT onto the public internet with nat: null", () => {
      const net = network()
      net.addNat("home", { host: "203.0.113.1" })
      net.attach("phone", phone, { nat: "home" })
      net.attach("bob", bob)
      net.move("phone", alice, { nat: null })
      net.send("bob", alice, ping, 0)
      expect(settle(net)).toMatchObject([{ host: "phone", from: bob }])
    })
  })

  it("labels destinations by host, NAT or raw address", () => {
    const net = network()
    net.addNat("home", { host: "203.0.113.1" })
    net.attach("alice", alice)
    net.attach("phone", phone, { nat: "home" })
    net.attach("laptop", laptop, { nat: "home" })
    net.send("alice", bob, ping, 0)
    net.send("alice", { ...bob, host: "203.0.113.1" }, ping, 0)
    net.send("phone", laptop, ping, 0)
    net.send("phone", alice, ping, 0)
    expect(net.trace.map((packet) => packet.to)).toEqual([
      "UDP:192.0.2.20:5060",
      "home",
      "laptop",
      "alice",
    ])
  })
})
