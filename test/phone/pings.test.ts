import { describe, expect, it } from "vitest"
import { createResponse, type SipRequest } from "../../src/core"
import { createOptionsRequest } from "../../src/core/requests"
import { createPings } from "../../src/phone/pings"
import { createRandom } from "../../src/simulation/random"
import { alice, bob } from "../helpers"

const identity = { address: alice, aor: "sip:alice@example.com", random: createRandom(1) }

function options(callId: string): SipRequest {
  return createOptionsRequest("sip:bob@example.com", identity, callId)
}

const answer = (request: SipRequest, status: number) =>
  ({ type: "response", response: createResponse(request, status, "X"), from: bob }) as const

describe("createPings", () => {
  it("resolves with the final status and the rounded round-trip time", async () => {
    const pings = createPings()
    const ping = pings.wait("p1", 10)
    pings.settle(answer(options("p1"), 100), 20)
    pings.settle(answer(options("other"), 200), 30)
    pings.settle(answer(options("p1"), 404), 33.6)
    pings.settle(answer(options("p1"), 200), 40)
    expect(await ping).toStrictEqual({ status: 404, rtt: 24 })
  })

  it("rejects when the request timed out and ignores timeouts of others", async () => {
    const pings = createPings()
    const ping = pings.wait("p1", 0)
    pings.settle({ type: "timeout", request: options("other") }, 1)
    pings.settle({ type: "invalid", error: "x", from: bob }, 1)
    pings.settle({ type: "timeout", request: options("p1") }, 32_000)
    const error = await ping.catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(DOMException)
    expect(error).toMatchObject({
      name: "TimeoutError",
      message: "No answer to OPTIONS sip:bob@example.com",
    })
  })

  it("rejects everything still waiting on abort", async () => {
    const pings = createPings()
    const first = pings.wait("p1", 0)
    const second = pings.wait("p2", 0)
    pings.abort(new Error("gone"))
    await expect(first).rejects.toThrow("gone")
    await expect(second).rejects.toThrow("gone")
    pings.settle(answer(options("p1"), 200), 1)
  })
})
