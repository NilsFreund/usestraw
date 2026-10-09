import { describe, expect, it } from "vitest"
import type { Address } from "../../../src"
import { createHosts } from "../../../src/simulation/network/hosts"
import { createNaming } from "../../../src/simulation/network/naming"
import { createNats } from "../../../src/simulation/network/nats"
import { createStreams } from "../../../src/simulation/random"
import { alice, bob } from "../../helpers"

const phone: Address = { transport: "UDP", host: "192.168.1.10", port: 5060 }
const laptop: Address = { transport: "UDP", host: "100.64.0.20", port: 5060 }

function world() {
  const stream = createStreams(1)
  const hosts = createHosts(stream)
  const nats = createNats(stream)
  nats.add("carrier", { host: "198.51.100.1" })
  nats.add("home", { host: "100.64.0.7", behind: "carrier" })
  hosts.add("phone", phone, { nat: "home" })
  hosts.add("laptop", laptop, { nat: "carrier" })
  hosts.add("alice", alice, {})
  return createNaming(hosts, nats)
}

describe("createNaming", () => {
  it("resolves hosts and NATs to their outermost site", () => {
    const naming = world()
    expect(["phone", "laptop", "home", "carrier", "alice"].map(naming.site)).toEqual([
      "carrier",
      "carrier",
      "carrier",
      "carrier",
      "alice",
    ])
  })

  it("rejects unknown names", () => {
    expect(() => world().site("bobb")).toThrow("Unknown host or NAT bobb")
  })

  it("labels destinations through the whole NAT chain of the sender", () => {
    const naming = world()
    expect(naming.label(laptop, "home")).toBe("laptop")
    expect(naming.label({ ...laptop, host: "100.64.0.7" }, "home")).toBe("home")
    expect(naming.label(phone, "home")).toBe("phone")
  })

  it("labels public hosts, public NATs and unknown addresses", () => {
    const naming = world()
    expect(naming.label(alice, "home")).toBe("alice")
    expect(naming.label({ ...bob, host: "198.51.100.1" }, undefined)).toBe("carrier")
    expect(naming.label(bob, undefined)).toBe("UDP:192.0.2.20:5060")
  })
})
