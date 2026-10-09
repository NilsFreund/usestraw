import { describe, expect, it } from "vitest"
import { endpointKey, mappingKey, portKey } from "../../../../src/simulation/network/nat/keys"
import { alice, bob } from "../../../helpers"

describe("keys", () => {
  it("builds endpoint and port keys", () => {
    expect(endpointKey(alice)).toBe("192.0.2.10:5060")
    expect(portKey("UDP", 40000)).toBe("UDP:40000")
  })

  it("scopes mapping keys by the mapping behavior (RFC 4787)", () => {
    expect(mappingKey("endpoint-independent", alice, bob)).toBe("UDP:192.0.2.10:5060")
    expect(mappingKey("address-dependent", alice, bob)).toBe("UDP:192.0.2.10:5060>192.0.2.20")
    expect(mappingKey("address-and-port-dependent", alice, bob)).toBe(
      "UDP:192.0.2.10:5060>192.0.2.20:5060",
    )
  })
})
