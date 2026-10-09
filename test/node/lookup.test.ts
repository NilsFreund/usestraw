import { describe, expect, it, vi } from "vitest"
import { RegistrationError, register } from "../../src/node"

vi.mock("node:dns/promises", () => ({
  lookup: (host: string) =>
    Promise.reject(
      Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }),
    ),
}))

describe("register", () => {
  it("reports a host that does not resolve as a network error", async () => {
    const error = await register({
      uri: "sip:alice@example.com",
      server: "udp://sip.example.com",
    }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(RegistrationError)
    expect(error).toMatchObject({
      failure: { reason: "network" },
      message:
        "Network error with udp://sip.example.com:5060: getaddrinfo ENOTFOUND sip.example.com",
    })
  })
})
