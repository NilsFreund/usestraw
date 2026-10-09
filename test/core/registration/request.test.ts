import { describe, expect, it } from "vitest"
import { serializeMessage } from "../../../src"
import { createRegisterRequest, createRegistrant } from "../../../src/core/registration/request"
import { createRandom } from "../../../src/simulation/random"
import { alice, parsed } from "../../helpers"

const identity = { address: alice, aor: "sip:alice@example.com", random: createRandom(1) }

describe("createRegistrant", () => {
  it("binds the address of record to our contact with a tagged From", () => {
    const registrant = createRegistrant(identity)
    expect(registrant.from.uri).toBe("sip:alice@example.com")
    expect(registrant.from.params.get("tag")).toMatch(/^[a-z0-9]{10}$/)
    expect(registrant.to).toStrictEqual({ uri: "sip:alice@example.com", params: new Map() })
    expect(registrant.callId).toMatch(/^[a-z0-9]{20}$/)
    expect(registrant.contact.uri).toBe("sip:alice@192.0.2.10:5060")
  })
})

describe("createRegisterRequest", () => {
  it("builds a REGISTER that round-trips through the parser", () => {
    const registrant = createRegistrant(identity)
    const request = createRegisterRequest(registrant, "sip:example.com", 7, 600, identity)
    expect(request).toMatchObject({
      method: "REGISTER",
      uri: "sip:example.com",
      cseq: { seq: 7, method: "REGISTER" },
      callId: registrant.callId,
      contact: [registrant.contact],
      headers: [
        { name: "Expires", value: "600" },
        { name: "Supported", value: "path" },
      ],
    })
    expect(parsed(serializeMessage(request))).toStrictEqual(request)
  })
})
