import { describe, expect, it } from "vitest"
import { createNats } from "../../../src/simulation/network/nats"
import { createStreams } from "../../../src/simulation/random"

const nats = () => createNats(createStreams(1))

describe("createNats", () => {
  it("registers NATs by id and public host", () => {
    const registry = nats()
    registry.add("home", { host: "203.0.113.1" })
    expect(registry.get("home").host).toBe("203.0.113.1")
    expect(registry.at("203.0.113.1", undefined)).toBe("home")
    expect(registry.at("203.0.113.9", undefined)).toBeUndefined()
    expect(registry.parent("home")).toBeUndefined()
  })

  it("nests NATs behind carrier NATs", () => {
    const registry = nats()
    registry.add("carrier", { host: "198.51.100.1" })
    registry.add("home", { host: "100.64.0.7", behind: "carrier" })
    expect(registry.parent("home")).toBe("carrier")
    expect(registry.at("100.64.0.7", "carrier")).toBe("home")
    expect(registry.at("100.64.0.7", undefined)).toBeUndefined()
    expect(registry.outermost("home")).toBe("carrier")
    expect(registry.outermost("carrier")).toBe("carrier")
  })

  it("allows the same inner public host behind different carriers", () => {
    const registry = nats()
    registry.add("a", { host: "198.51.100.1" })
    registry.add("b", { host: "198.51.100.2" })
    registry.add("homeA", { host: "100.64.0.7", behind: "a" })
    registry.add("homeB", { host: "100.64.0.7", behind: "b" })
    expect(registry.at("100.64.0.7", "b")).toBe("homeB")
  })

  it("rejects duplicates and unknown NATs", () => {
    const registry = nats()
    registry.add("home", { host: "203.0.113.1" })
    expect(() => registry.add("home", { host: "203.0.113.2" })).toThrow("NAT home already exists")
    expect(() => registry.add("other", { host: "203.0.113.1" })).toThrow(
      "Public host 203.0.113.1 is already taken",
    )
    expect(() => registry.add("inner", { host: "10.0.0.1", behind: "nowhere" })).toThrow(
      "Unknown NAT nowhere",
    )
    expect(() => registry.get("nowhere")).toThrow("Unknown NAT nowhere")
    expect(() => registry.parent("nowhere")).toThrow("Unknown NAT nowhere")
  })
})
