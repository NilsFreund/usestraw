import { describe, expect, it } from "vitest"
import type { CoreEvent, TransportAddress } from "../../src/core"
import { latency } from "../../src/simulation/network/conditions"
import { type NatType, natTypes } from "../../src/simulation/network/nat/types"
import type { NatSetup } from "../../src/simulation/network/nats"
import { createSimulation } from "../../src/simulation/simulation"
import { bob, bytes, options, outcomes, userAgent } from "../helpers"

const phoneAddress: TransportAddress = { transport: "UDP", host: "192.168.1.10", port: 5060 }
const server: TransportAddress = bob
const carolAddress: TransportAddress = { transport: "UDP", host: "198.51.100.77", port: 5060 }
const types = Object.keys(natTypes) as NatType[]

function home(type: NatType, setup: Partial<NatSetup> = {}) {
  const simulation = createSimulation({ seed: 1, internet: { latency: latency.fixed(20) } })
  simulation.network.addNat("home", {
    host: "203.0.113.1",
    ports: "sequential",
    ...natTypes[type],
    ...setup,
  })
  const phone = simulation.addNode("phone", phoneAddress, userAgent("phone", phoneAddress), {
    nat: "home",
  })
  const box = simulation.addNode("server", server, userAgent("server", server))
  const carol = simulation.addNode("carol", carolAddress, userAgent("carol", carolAddress))
  const ping = (at: number, from: typeof phone, to: TransportAddress) =>
    simulation.at(at, () => simulation.command(from, options(to, "sip:phone@example.com")))
  return { simulation, phone, box, carol, ping }
}

function requestSource(events: readonly CoreEvent[]): TransportAddress {
  const request = events.find((event) => event.type === "answered")
  if (request?.type !== "answered") throw new Error("No request received")
  return request.from
}

const mapped: TransportAddress = { transport: "UDP", host: "203.0.113.1", port: 49152 }

describe("behind a home NAT", () => {
  it.each(types)("reaches a public server from a %s NAT thanks to rport", (type) => {
    const { simulation, phone, box, ping } = home(type)
    ping(0, phone, server)
    simulation.run()
    expect(outcomes(phone.events)).toEqual(["response"])
    expect(requestSource(box.events)).toEqual(mapped)
    const request = box.events[0]
    expect(request?.type === "answered" && request.request.via[0]?.params).toEqual(
      new Map([
        ["branch", expect.any(String)],
        ["rport", "49152"],
        ["received", "203.0.113.1"],
      ]),
    )
  })

  it.each(types)("drops unsolicited OPTIONS at a %s NAT", (type) => {
    const { simulation, box, ping } = home(type)
    ping(0, box, mapped)
    simulation.run()
    expect(outcomes(box.events)).toEqual(["timeout"])
    expect(simulation.trace[0]?.fates).toMatchObject([{ reason: "nat", hop: "ingress" }])
  })

  it.each<[NatType, string[]]>([
    ["fullCone", ["response", "response"]],
    ["restrictedCone", ["response", "timeout"]],
    ["portRestrictedCone", ["response", "timeout"]],
    ["symmetric", ["response", "timeout"]],
  ])("filters inbound pings on a %s NAT as %o for server and stranger", (type, expected) => {
    const { simulation, phone, box, carol, ping } = home(type)
    ping(0, phone, server)
    ping(1000, box, mapped)
    ping(1000, carol, mapped)
    simulation.run()
    expect([...outcomes(box.events), ...outcomes(carol.events)]).toEqual(expected)
  })

  it("gives every destination its own port on a symmetric NAT", () => {
    const { simulation, phone, box, carol, ping } = home("symmetric")
    ping(0, phone, server)
    ping(0, phone, carolAddress)
    simulation.run()
    expect(requestSource(box.events).port).not.toBe(requestSource(carol.events).port)
  })

  it("loses the mapping after 30 s of silence", () => {
    const { simulation, phone, box, ping } = home("portRestrictedCone")
    ping(0, phone, server)
    ping(31_000, box, mapped)
    simulation.run()
    expect(outcomes(box.events)).toEqual(["timeout"])
  })

  it("keeps the mapping alive with keepalives every 20 s", () => {
    const { simulation, phone, box, ping } = home("portRestrictedCone")
    for (const at of [0, 20_000, 40_000]) ping(at, phone, server)
    ping(55_000, box, mapped)
    simulation.run()
    expect(outcomes(box.events)).toEqual(["response"])
  })

  it("breaks reachability when the NAT reboots", () => {
    const { simulation, phone, box, ping } = home("fullCone")
    ping(0, phone, server)
    simulation.at(10_000, () => simulation.network.resetNat("home"))
    ping(15_000, box, mapped)
    simulation.run()
    expect(outcomes(box.events)).toEqual(["timeout"])
  })

  it("loses replies to clients that did not ask for rport", () => {
    const { simulation, phone } = home("fullCone")
    const withoutRport = bytes(
      [
        "OPTIONS sip:server@example.com SIP/2.0",
        "Via: SIP/2.0/UDP 192.168.1.10:5060;branch=z9hG4bKnorport",
        "From: <sip:phone@example.com>;tag=p1",
        "To: <sip:server@example.com>",
        "Call-ID: norport",
        "CSeq: 1 OPTIONS",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"),
    )
    simulation.network.send(phone.name, server, withoutRport, 0)
    simulation.run()
    expect(simulation.trace.map((packet) => packet.fates[0])).toMatchObject([
      { type: "delivered", host: "server" },
      { type: "dropped", reason: "nat" },
    ])
    expect(simulation.trace[1]?.to).toBe("home")
  })
})

describe("behind a carrier-grade NAT", () => {
  it("reaches the server through home and carrier NAT", () => {
    const simulation = createSimulation({ seed: 1, internet: { latency: latency.fixed(20) } })
    simulation.network.addNat("carrier", { host: "198.51.100.1", ports: "sequential" })
    simulation.network.addNat("home", {
      host: "100.64.0.7",
      behind: "carrier",
      ports: "sequential",
    })
    const phone = simulation.addNode("phone", phoneAddress, userAgent("phone", phoneAddress), {
      nat: "home",
    })
    const box = simulation.addNode("server", server, userAgent("server", server))
    simulation.command(phone, options(server))
    simulation.run()
    expect(outcomes(phone.events)).toEqual(["response"])
    expect(requestSource(box.events).host).toBe("198.51.100.1")
  })
})
