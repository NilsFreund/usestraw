import { describe, expect, it, vi } from "vitest"
import { ConnectError, connect } from "../../src/node"

vi.mock("node:dns/promises", () => ({
  lookup: (host: string) =>
    Promise.reject(
      Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }),
    ),
}))

describe("connect", () => {
  it("reports a host that does not resolve as a network error", async () => {
    const error = await connect({
      uri: "sip:alice@example.com",
      server: "udp://sip.example.com",
    }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ConnectError)
    expect(error).toMatchObject({
      reason: "network",
      message:
        "Network error with udp://sip.example.com:5060: getaddrinfo ENOTFOUND sip.example.com",
    })
  })
})
