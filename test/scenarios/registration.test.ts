import { describe, expect, it } from "vitest"
import {
  type CoreEvent,
  type Credentials,
  createCore,
  getHeader,
  type Random,
  type TransportAddress,
} from "../../src"
import { type LinkConditions, latency, loss } from "../../src/simulation/network/conditions"
import { natTypes } from "../../src/simulation/network/nat/types"
import { outage } from "../../src/simulation/scenarios"
import { createSimulation } from "../../src/simulation/simulation"
import { formatTrace } from "../../src/simulation/trace"
import { alice, bob } from "../helpers"
import { type Registrar, type RegistrarOptions, registrar } from "../registrar"

const account: Credentials = { username: "alice", password: "secret" }

function phone(address: TransportAddress, credentials: Credentials = account) {
  return (random: Random) =>
    createCore({ address, aor: "sip:alice@example.com", random, credentials })
}

function setup(
  options: RegistrarOptions = {},
  credentials: Credentials = account,
  internet: LinkConditions = { latency: latency.fixed(20) },
  seed = 1,
) {
  const simulation = createSimulation({ seed, internet })
  const ua = simulation.addNode("phone", alice, phone(alice, credentials))
  let server: Registrar | undefined
  simulation.addNode("registrar", bob, (random) => {
    server = registrar(options)(random)
    return server
  })
  if (!server) throw new Error("No registrar")
  simulation.command(ua, { type: "register", to: bob, expires: 120 })
  return { simulation, ua, registers: server.registers, bindings: server.bindings }
}

function registrations(events: readonly CoreEvent[]) {
  return events.flatMap((event) => (event.type === "registration" ? [event] : []))
}

describe("registration against a digest registrar", () => {
  it("authenticates with SHA-256 and refreshes around half the expiry", () => {
    const { simulation, ua } = setup({ algorithm: "SHA-256" })
    simulation.run(66_000)
    expect(formatTrace(simulation.trace)).toBe(
      [
        "     0ms  phone → registrar  REGISTER sip:example.com SIP/2.0  (+20ms)",
        "    20ms  registrar → phone  SIP/2.0 401 Unauthorized  (+20ms)",
        "    40ms  phone → registrar  REGISTER sip:example.com SIP/2.0  (+20ms)",
        "    60ms  registrar → phone  SIP/2.0 200 OK  (+20ms)",
        " 62830ms  phone → registrar  REGISTER sip:example.com SIP/2.0  (+20ms)",
        " 62850ms  registrar → phone  SIP/2.0 401 Unauthorized  (+20ms)",
        " 62870ms  phone → registrar  REGISTER sip:example.com SIP/2.0  (+20ms)",
        " 62890ms  registrar → phone  SIP/2.0 200 OK  (+20ms)",
      ].join("\n"),
    )
    expect(registrations(ua.events)).toStrictEqual([
      { type: "registration", state: "registered", expires: 120 },
      { type: "registration", state: "registered", expires: 120 },
    ])
  })

  it.each(["MD5", "SHA-512-256", "MD5-sess"])("registers with %s", (algorithm) => {
    const { simulation, ua } = setup({ algorithm })
    simulation.run(1000)
    expect(registrations(ua.events)).toMatchObject([{ state: "registered" }])
  })

  it("registers with a legacy registrar that sends no qop (RFC 2069)", () => {
    const { simulation, ua, registers } = setup({ qop: false })
    simulation.run(1000)
    expect(registrations(ua.events)).toMatchObject([{ state: "registered" }])
    const authorization = registers
      .flatMap((request) => request.headers)
      .find((header) => header.name === "Authorization")
    expect(authorization?.value).toMatch(/^Digest username="alice"/)
    expect(authorization?.value).not.toMatch(/qop|cnonce|nc=/)
  })

  it("stops after a wrong password without hammering the registrar", () => {
    const { simulation, ua, registers } = setup({}, { username: "alice", password: "wrong" })
    simulation.run(600_000)
    expect(registrations(ua.events)).toStrictEqual([
      { type: "registration", state: "failed", failure: { reason: "unauthorized", status: 401 } },
    ])
    expect(registers).toHaveLength(2)
  })

  it("raises the expiry after 423 Interval Too Brief", () => {
    const { simulation, ua, registers } = setup({ minExpires: 300 })
    simulation.run(1000)
    expect(registrations(ua.events)).toMatchObject([{ state: "registered", expires: 300 }])
    expect(registers.map((request) => getHeader(request, "Expires"))).toStrictEqual([
      "120",
      "120",
      "300",
    ])
  })

  it("waits for Retry-After when the registrar is busy", () => {
    const { simulation, ua, registers } = setup({ script: [503], retryAfter: 60 })
    simulation.run(61_000)
    expect(registrations(ua.events)).toMatchObject([
      { state: "failed", failure: { reason: "rejected", status: 503 }, retryIn: 60_000 },
      { state: "registered" },
    ])
    expect(registers).toHaveLength(3)
  })

  it("keeps trying through an outage and registers again afterwards", () => {
    const { simulation, ua } = setup()
    outage(simulation, "registrar", 30_000, 300_000)
    simulation.run(900_000)
    const states = registrations(ua.events).map((event) => event.state)
    expect(states[0]).toBe("registered")
    expect(states).toContain("failed")
    expect(states.at(-1)).toBe("registered")
    const retries = registrations(ua.events).flatMap((event) =>
      event.state === "failed" && event.retryIn !== undefined ? [event.retryIn] : [],
    )
    expect(retries.length).toBeGreaterThan(2)
    for (const [index, retry] of retries.entries()) {
      expect(retry).toBeGreaterThanOrEqual(30_000 * 2 ** index)
      expect(retry).toBeLessThanOrEqual(60_000 * 2 ** index)
    }
  })

  it("registers through 30 % loss and 10 % duplicates in every seed", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const simulation = createSimulation({
        seed,
        internet: { latency: latency.uniform(10, 80), loss: loss.random(0.3), duplicate: 0.1 },
      })
      const ua = simulation.addNode("phone", alice, phone(alice))
      simulation.addNode("registrar", bob, registrar())
      simulation.command(ua, { type: "register", to: bob, expires: 120 })
      simulation.run(60_000)
      const first = registrations(ua.events)[0]
      expect(first, `seed ${seed}\n${formatTrace(simulation.trace)}`).toMatchObject({
        state: "registered",
      })
    }
  })

  it("keeps the registration alive when the NAT forgets its mapping", () => {
    const simulation = createSimulation({ seed: 1, internet: { latency: latency.fixed(20) } })
    simulation.network.addNat("home", {
      host: "203.0.113.1",
      ports: "random",
      ...natTypes.portRestrictedCone,
    })
    const ua = simulation.addNode(
      "phone",
      { ...alice, host: "192.168.1.10" },
      phone({ ...alice, host: "192.168.1.10" }),
      {
        nat: "home",
      },
    )
    let server: Registrar | undefined
    simulation.addNode("registrar", bob, (random) => {
      server = registrar()(random)
      return server
    })
    simulation.command(ua, { type: "register", to: bob, expires: 120 })
    simulation.at(100_000, () => simulation.network.resetNat("home"))
    simulation.run(200_000)
    const states = new Set(registrations(ua.events).map((event) => event.state))
    expect(states).toStrictEqual(new Set(["registered"]))
    expect([...(server?.bindings.keys() ?? [])]).toStrictEqual([
      expect.stringMatching(/^sip:alice@203\.0\.113\.1:\d+$/),
    ])
  })

  it("unregisters with Expires 0 and stops refreshing", () => {
    const { simulation, ua, registers } = setup()
    simulation.at(10_000, () => simulation.command(ua, { type: "unregister" }))
    simulation.run(600_000)
    expect(registrations(ua.events).map((event) => event.state)).toStrictEqual([
      "registered",
      "unregistered",
    ])
    expect(registers.map((request) => getHeader(request, "Expires"))).toStrictEqual([
      "120",
      "120",
      "0",
      "0",
    ])
  })

  it("answers a proxy challenge with Proxy-Authorization", () => {
    const { simulation, ua, registers } = setup({ proxy: true })
    simulation.run(1000)
    expect(registrations(ua.events)).toMatchObject([{ state: "registered" }])
    const answers = registers.map((request) => getHeader(request, "Proxy-Authorization") ?? "")
    expect(answers).toStrictEqual(["", expect.stringMatching(/^Digest username="alice"/)])
  })

  it("gives up when every nonce has already gone stale", () => {
    const { simulation, ua, registers } = setup({ nonceLifetime: 10 })
    simulation.run(600_000)
    expect(registrations(ua.events)).toStrictEqual([
      { type: "registration", state: "failed", failure: { reason: "unauthorized", status: 401 } },
    ])
    expect(registers).toHaveLength(4)
  })

  it("reports the shorter expiry the registrar granted", () => {
    const { simulation, ua } = setup({ maxExpires: 60 })
    simulation.run(1000)
    expect(registrations(ua.events)).toMatchObject([{ state: "registered", expires: 60 }])
  })

  it("follows the expiry of a Contact the registrar rewrote behind NAT", () => {
    const { simulation, ua } = setup({ rewrite: "sip:alice@203.0.113.1:49152", maxExpires: 30 })
    simulation.run(40_000)
    expect(
      registrations(ua.events).map((event) => event.state === "registered" && event.expires),
    ).toStrictEqual([30, 30, 30])
  })

  it("does not storm a registrar that asks for Retry-After: 0", () => {
    const { simulation, registers } = setup({
      script: Array.from({ length: 50 }, () => 503),
      retryAfter: 0,
    })
    simulation.run(600_000)
    expect(registers.length).toBeLessThanOrEqual(5)
  })

  it("leaves no binding behind when unregistering while a register is still in flight", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const lossy = { latency: latency.uniform(10, 80), loss: loss.random(0.3) }
      const { simulation, ua, bindings } = setup({}, account, lossy, seed)
      simulation.at(30, () => simulation.command(ua, { type: "unregister" }))
      simulation.run(300_000)
      expect(bindings.size, `seed ${seed}\n${formatTrace(simulation.trace)}`).toBe(0)
    }
  })
})
