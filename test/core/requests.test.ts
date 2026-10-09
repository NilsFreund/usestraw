import { describe, expect, it } from "vitest"
import { serializeMessage } from "../../src"
import { createOptionsRequest } from "../../src/core/requests"
import { createRandom } from "../../src/simulation/random"
import { alice, parsed } from "../helpers"

const identity = { address: alice, aor: "sip:alice@example.com", random: createRandom(1) }

describe("createOptionsRequest", () => {
  it("builds an out-of-dialog OPTIONS request from the identity", () => {
    const request = createOptionsRequest("sip:bob@example.com", identity)
    expect(request).toMatchObject({
      method: "OPTIONS",
      uri: "sip:bob@example.com",
      maxForwards: 70,
      from: { uri: "sip:alice@example.com" },
      to: { uri: "sip:bob@example.com", params: new Map() },
      cseq: { seq: 1, method: "OPTIONS" },
      contact: [],
      headers: [],
      via: [{ transport: "UDP", host: "192.0.2.10", port: 5060 }],
    })
    expect(request.via[0]?.params.get("rport")).toBeNull()
  })

  it("serializes into a message the parser accepts unchanged", () => {
    const request = createOptionsRequest("sip:bob@example.com", identity)
    expect(parsed(serializeMessage(request))).toEqual(request)
  })

  it("brackets IPv6 hosts in Via", () => {
    const v6 = { ...identity, address: { ...alice, host: "2001:db8::1" } }
    expect(createOptionsRequest("sip:bob@example.com", v6).via[0]?.host).toBe("[2001:db8::1]")
  })

  it("draws fresh identifiers for every request", () => {
    const random = createRandom(2)
    const first = createOptionsRequest("sip:bob@example.com", { ...identity, random })
    const second = createOptionsRequest("sip:bob@example.com", { ...identity, random })
    expect(first.callId).not.toBe(second.callId)
    expect(first.via[0]?.params.get("branch")).not.toBe(second.via[0]?.params.get("branch"))
  })
})
