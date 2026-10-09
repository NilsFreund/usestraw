import { describe, expect, it } from "vitest"
import { latency, loss } from "../../../src/simulation/network/conditions"
import { createHosts } from "../../../src/simulation/network/hosts"
import { createStreams } from "../../../src/simulation/random"
import { alice, bob } from "../../helpers"

const hosts = () => createHosts(createStreams(1))
const lan = { transport: "UDP", host: "192.168.1.10", port: 5060 } as const

describe("createHosts", () => {
  it("adds hosts and finds them by address within their site", () => {
    const registry = hosts()
    registry.add("alice", alice, {})
    registry.add("phone", lan, { nat: "home" })
    expect(registry.get("alice")).toMatchObject({ id: "alice", address: alice, offline: false })
    expect(registry.find(alice, undefined)?.id).toBe("alice")
    expect(registry.find(lan, "home")?.id).toBe("phone")
    expect(registry.find(lan, undefined)).toBeUndefined()
    expect(registry.find(bob, undefined)).toBeUndefined()
  })

  it("allows the same private address behind different NATs", () => {
    const registry = hosts()
    registry.add("a", lan, { nat: "home" })
    registry.add("b", lan, { nat: "office" })
    expect(registry.find(lan, "office")?.id).toBe("b")
  })

  it("rejects duplicate ids and taken addresses", () => {
    const registry = hosts()
    registry.add("alice", alice, {})
    expect(() => registry.add("alice", bob, {})).toThrow("Host alice already exists")
    expect(() => registry.add("eve", alice, {})).toThrow(
      "Address UDP:192.0.2.10:5060 is already taken by alice",
    )
  })

  it("rejects unknown hosts", () => {
    expect(() => hosts().get("nobody")).toThrow("Unknown host nobody")
  })

  it("does not claim an address when the access conditions are invalid", () => {
    const registry = hosts()
    expect(() => registry.add("alice", alice, { access: { loss: loss.random(2) } })).toThrow(
      RangeError,
    )
    expect(registry.find(alice, undefined)).toBeUndefined()
  })

  it("applies symmetric and asymmetric access conditions", () => {
    const registry = hosts()
    const wifi = { latency: latency.fixed(5) }
    registry.add("alice", alice, { access: wifi })
    registry.add("bob", bob, { access: { up: { down: true }, down: wifi } })
    expect(registry.get("alice").up.conditions).toBe(wifi)
    expect(registry.get("alice").down.conditions).toBe(wifi)
    expect(registry.get("bob").up.conditions).toEqual({ down: true })
  })

  describe("move", () => {
    it("changes address and site and frees the old address", () => {
      const registry = hosts()
      registry.add("alice", alice, {})
      registry.move("alice", lan, { nat: "home" })
      expect(registry.get("alice")).toMatchObject({ address: lan, nat: "home" })
      expect(registry.find(lan, "home")?.id).toBe("alice")
      registry.add("bob", alice, {})
      expect(registry.find(alice, undefined)?.id).toBe("bob")
    })

    it("keeps the access link unless a new one is given", () => {
      const registry = hosts()
      registry.add("alice", alice, { access: { latency: latency.fixed(5) } })
      const { up } = registry.get("alice")
      registry.move("alice", bob, {})
      expect(registry.get("alice").up).toBe(up)
      registry.move("alice", alice, { access: { latency: latency.fixed(50) } })
      expect(registry.get("alice").up.conditions).toEqual({ latency: latency.fixed(50) })
    })

    it("keeps the old address when the new one is taken", () => {
      const registry = hosts()
      registry.add("alice", alice, {})
      registry.add("bob", bob, {})
      expect(() => registry.move("alice", bob, {})).toThrow("already taken by bob")
      expect(registry.find(alice, undefined)?.id).toBe("alice")
      expect(registry.get("alice").address).toEqual(alice)
    })

    it("keeps the NAT when none is given and leaves it with null", () => {
      const registry = hosts()
      registry.add("phone", lan, { nat: "home" })
      registry.move("phone", { ...lan, port: 5070 }, {})
      expect(registry.get("phone").nat).toBe("home")
      registry.move("phone", alice, { nat: null })
      expect(registry.get("phone").nat).toBeUndefined()
      expect(registry.find(alice, undefined)?.id).toBe("phone")
    })

    it("treats a null NAT on add as the public internet", () => {
      const registry = hosts()
      registry.add("alice", alice, { nat: null })
      expect(registry.find(alice, undefined)?.id).toBe("alice")
    })

    it("can stay on the same address", () => {
      const registry = hosts()
      registry.add("alice", alice, {})
      registry.move("alice", alice, {})
      expect(registry.find(alice, undefined)?.id).toBe("alice")
    })
  })

  it("keeps a saturated queue when the access link is retuned", () => {
    const registry = hosts()
    registry.add("alice", alice, { access: { bandwidth: 8000 } })
    registry.get("alice").up.traverse(new Uint8Array(), 1000, 0)
    registry.setAccess("alice", { bandwidth: 8000 })
    const result = registry.get("alice").up.traverse(new Uint8Array(), 1000, 0)
    expect(result).toMatchObject({ type: "passed", copies: [{ at: 2000 }] })
  })

  it("leaves a host untouched when the new access link is invalid", () => {
    const registry = hosts()
    registry.add("alice", alice, {})
    expect(() => registry.move("alice", bob, { access: { mtu: 0 } })).toThrow(RangeError)
    expect(registry.get("alice").address).toEqual(alice)
    expect(registry.find(bob, undefined)).toBeUndefined()
  })

  it("tracks which IPs are in use per site, across ports", () => {
    const registry = hosts()
    registry.add("alice", alice, {})
    registry.add("alice2", { ...alice, port: 5070 }, {})
    registry.add("phone", lan, { nat: "home" })
    registry.move("alice", { ...bob, port: 6000 }, {})
    expect(registry.uses(alice.host, undefined)).toBe(true)
    registry.move("alice2", { ...bob, port: 6001 }, {})
    expect(registry.uses(alice.host, undefined)).toBe(false)
    expect([registry.uses(bob.host, undefined), registry.uses(lan.host, "home")]).toEqual([
      true,
      true,
    ])
    expect(registry.uses(lan.host, undefined)).toBe(false)
  })

  it("replaces the access link", () => {
    const registry = hosts()
    registry.add("alice", alice, {})
    registry.setAccess("alice", { latency: latency.fixed(9) })
    expect(registry.get("alice").down.conditions).toEqual({ latency: latency.fixed(9) })
  })

  it("stays offline until every disconnect is matched by a reconnect", () => {
    const registry = hosts()
    registry.add("alice", alice, {})
    registry.disconnect("alice")
    registry.disconnect("alice")
    registry.reconnect("alice")
    expect(registry.get("alice").offline).toBe(true)
    registry.reconnect("alice")
    expect(registry.get("alice").offline).toBe(false)
  })

  it("ignores reconnects without a matching disconnect", () => {
    const registry = hosts()
    registry.add("alice", alice, {})
    registry.reconnect("alice")
    registry.disconnect("alice")
    expect(registry.get("alice").offline).toBe(true)
  })

  it("knows which hosts exist", () => {
    const registry = hosts()
    registry.add("alice", alice, {})
    expect([registry.has("alice"), registry.has("bob")]).toEqual([true, false])
  })
})
