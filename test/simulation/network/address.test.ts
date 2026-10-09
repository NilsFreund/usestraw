import { describe, expect, it } from "vitest"
import { addressKey, sameAddress } from "../../../src/simulation/network/address"
import { alice } from "../../helpers"

describe("addressKey", () => {
  it("joins transport, host and port", () => {
    expect(addressKey(alice)).toBe("UDP:192.0.2.10:5060")
  })
})

describe("sameAddress", () => {
  it("compares transport, host and port", () => {
    expect(sameAddress(alice, { ...alice })).toBe(true)
    expect(sameAddress(alice, { ...alice, port: 5061 })).toBe(false)
    expect(sameAddress(alice, { ...alice, transport: "TCP" })).toBe(false)
  })
})
