import { describe, expect, it } from "vitest"
import type { Address } from "../../../../src"
import { createNat } from "../../../../src/simulation/network/nat/nat"
import {
  type NatBehavior,
  type NatOptions,
  natTypes,
} from "../../../../src/simulation/network/nat/types"
import { createRandom } from "../../../../src/simulation/random"

const phone: Address = { transport: "UDP", host: "192.168.1.10", port: 5060 }
const server: Address = { transport: "UDP", host: "198.51.100.5", port: 5060 }
const serverOtherPort: Address = { ...server, port: 5070 }
const stranger: Address = { transport: "UDP", host: "198.51.100.99", port: 5060 }

const nat = (options: Partial<NatOptions> = {}) =>
  createNat({ host: "203.0.113.1", ports: "sequential", ...options }, createRandom(1))

describe("createNat", () => {
  it("rewrites the source to the public host and an allocated port", () => {
    expect(nat().outbound(phone, server, 0)).toEqual({
      transport: "UDP",
      host: "203.0.113.1",
      port: 49152,
    })
  })

  it("forwards replies from the contacted endpoint to the internal address", () => {
    const box = nat()
    const external = box.outbound(phone, server, 0)
    expect(box.inbound(external, server, 10)).toEqual(phone)
  })

  it("drops packets for unknown ports", () => {
    expect(nat().inbound({ transport: "UDP", host: "203.0.113.1", port: 1 }, server, 0)).toBe(
      undefined,
    )
  })

  describe("mapping behavior", () => {
    it("reuses one mapping for every destination when endpoint-independent", () => {
      const box = nat({ mapping: "endpoint-independent" })
      expect(box.outbound(phone, server, 0)).toEqual(box.outbound(phone, stranger, 0))
    })

    it("opens one mapping per destination host when address-dependent", () => {
      const box = nat({ mapping: "address-dependent" })
      const first = box.outbound(phone, server, 0)
      expect(box.outbound(phone, serverOtherPort, 0)).toEqual(first)
      expect(box.outbound(phone, stranger, 0)).not.toEqual(first)
    })

    it("opens one mapping per destination endpoint when symmetric", () => {
      const box = nat({ mapping: "address-and-port-dependent" })
      expect(box.outbound(phone, server, 0)).not.toEqual(box.outbound(phone, serverOtherPort, 0))
    })

    it("keeps transports apart", () => {
      const box = nat()
      const udp = box.outbound(phone, server, 0)
      const tcp = box.outbound({ ...phone, transport: "TCP" }, { ...server, transport: "TCP" }, 0)
      expect(tcp.transport).toBe("TCP")
      expect(box.inbound(udp, server, 1)).toEqual(phone)
      expect(box.inbound({ ...udp, transport: "TCP" }, server, 1)).toBeUndefined()
    })
  })

  describe("filtering behavior", () => {
    const admitted = (filtering: NatBehavior, remote: Address) => {
      const box = nat({ filtering })
      const external = box.outbound(phone, server, 0)
      return box.inbound(external, remote, 10) !== undefined
    }

    it.each([
      ["endpoint-independent", [true, true, true]],
      ["address-dependent", [true, true, false]],
      ["address-and-port-dependent", [true, false, false]],
    ] as const)("admits %s as %o for server, other port, stranger", (filtering, expected) => {
      expect(
        [server, serverOtherPort, stranger].map((remote) => admitted(filtering, remote)),
      ).toEqual(expected)
    })
  })

  describe("timeouts", () => {
    it("expires idle mappings and allocates a new port afterwards", () => {
      const box = nat({ timeout: 30_000 })
      const external = box.outbound(phone, server, 0)
      expect(box.inbound(external, server, 30_000)).toEqual(phone)
      expect(box.inbound(external, server, 30_001)).toBeUndefined()
      expect(box.outbound(phone, server, 30_002).port).toBe(49153)
    })

    it("refreshes mappings on outbound traffic", () => {
      const box = nat({ timeout: 30_000 })
      const external = box.outbound(phone, server, 0)
      box.outbound(phone, server, 25_000)
      expect(box.inbound(external, server, 50_000)).toEqual(phone)
    })

    it("only refreshes on inbound traffic when configured", () => {
      const passive = nat({ timeout: 30_000 })
      const refreshing = nat({ timeout: 30_000, refreshOnInbound: true })
      for (const box of [passive, refreshing]) {
        const external = box.outbound(phone, server, 0)
        box.inbound(external, server, 25_000)
      }
      const external = { transport: "UDP", host: "203.0.113.1", port: 49152 } as const
      expect(passive.inbound(external, server, 50_000)).toBeUndefined()
      expect(refreshing.inbound(external, server, 50_000)).toEqual(phone)
    })

    it("expires mappings that were already expired when looked up outbound", () => {
      const box = nat({ timeout: 1000 })
      box.outbound(phone, server, 0)
      expect(box.outbound(phone, server, 5000).port).toBe(49153)
    })
  })

  it("forgets every mapping on reset", () => {
    const box = nat()
    const external = box.outbound(phone, server, 0)
    box.reset()
    expect(box.inbound(external, server, 1)).toBeUndefined()
  })

  it("defaults to a port-restricted cone with random ports and a 30 s timeout", () => {
    const box = createNat({ host: "203.0.113.1" }, createRandom(3))
    const external = box.outbound(phone, server, 0)
    expect(box.inbound(external, serverOtherPort, 1)).toBeUndefined()
    expect(box.inbound(external, server, 30_000)).toEqual(phone)
    expect(box.inbound(external, server, 60_001)).toBeUndefined()
  })
})

describe("natTypes", () => {
  it("maps the classic NAT names to RFC 4787 behaviors", () => {
    expect(natTypes).toEqual({
      fullCone: { mapping: "endpoint-independent", filtering: "endpoint-independent" },
      restrictedCone: { mapping: "endpoint-independent", filtering: "address-dependent" },
      portRestrictedCone: {
        mapping: "endpoint-independent",
        filtering: "address-and-port-dependent",
      },
      symmetric: { mapping: "address-and-port-dependent", filtering: "address-and-port-dependent" },
    })
  })
})
