import { describe, expect, it } from "vitest"
import { parseVia } from "../../src/message/fields/via"
import { acknowledges, clientKey, serverKey, serverKeys, topVia } from "../../src/transaction/keys"
import { request, response } from "./support"

describe("topVia", () => {
  it("returns the first Via", () => {
    expect(topVia(request()).params.get("branch")).toBe("z9hG4bKclient")
  })

  it("rejects messages without Via", () => {
    expect(() => topVia({ ...request(), via: [] })).toThrow("Message has no Via")
  })
})

describe("clientKey", () => {
  it("combines branch and CSeq method for requests and their responses", () => {
    const options = request("OPTIONS")
    expect(clientKey(options)).toBe("z9hG4bKclient|OPTIONS")
    expect(clientKey(response(options, 200))).toBe("z9hG4bKclient|OPTIONS")
  })

  it("tolerates responses without branch", () => {
    const options = request("OPTIONS")
    const [via] = options.via
    const stripped = { ...options, via: via ? [{ ...via, params: new Map() }] : [] }
    expect(clientKey(stripped)).toBe("|OPTIONS")
  })
})

describe("serverKey (RFC 3261 §17.2.3)", () => {
  it("uses branch, sent-by and method", () => {
    expect(serverKey(request("OPTIONS"))).toBe("z9hG4bKclient|192.0.2.10:5060|OPTIONS")
  })

  it("maps ACK onto the INVITE transaction", () => {
    expect(serverKey(request("ACK"))).toBe(serverKey(request("INVITE")))
  })

  it("normalizes the sent-by host and defaults the port", () => {
    const changed = {
      ...request("OPTIONS"),
      via: [parseVia("SIP/2.0/UDP [2001:DB8::1];branch=z9hG4bKclient")],
    }
    expect(serverKey(changed)).toBe("z9hG4bKclient|2001:db8::1:5060|OPTIONS")
  })

  it("defaults the sent-by port to 5061 for TLS", () => {
    const changed = {
      ...request("OPTIONS"),
      via: [parseVia("SIP/2.0/TLS client.example.com;branch=z9hG4bKclient")],
    }
    expect(serverKey(changed)).toBe("z9hG4bKclient|client.example.com:5061|OPTIONS")
  })

  it("falls back to RFC 2543 matching without the magic cookie", () => {
    expect(serverKey(request("INVITE", "legacy"))).toBe(
      "rfc2543|call-1|a1||1|INVITE|192.0.2.10:5060|sip:bob@example.com",
    )
  })
})

describe("serverKeys", () => {
  it("returns the single key for modern requests and non-ACK legacy requests", () => {
    expect(serverKeys(request("ACK"))).toEqual([serverKey(request("ACK"))])
    expect(serverKeys(request("INVITE", "legacy"))).toHaveLength(1)
  })

  it("also tries the INVITE key without To tag for an RFC 2543 ACK", () => {
    const ack = request("ACK", "legacy")
    const tagged = { ...ack, to: { ...ack.to, params: new Map([["tag", "b1"]]) } }
    expect(serverKeys(tagged)).toEqual([serverKey(tagged), serverKey(request("INVITE", "legacy"))])
  })

  it("treats an ACK without any branch as RFC 2543", () => {
    const [via] = request("ACK").via
    const bare = { ...request("ACK"), via: via ? [{ ...via, params: new Map() }] : [] }
    expect(serverKeys(bare)).toHaveLength(2)
  })

  it("tells RFC 2543 requests apart by their To tag", () => {
    const options = request("OPTIONS", "legacy")
    const tagged = { ...options, to: { ...options.to, params: new Map([["tag", "x"]]) } }
    expect(serverKey(tagged)).not.toBe(serverKey(options))
  })
})

describe("acknowledges", () => {
  const invite = request("INVITE", "z9hG4bKinvite")
  const failure = response(invite, 486, "b1")
  const tagged = (ack: ReturnType<typeof request>, tag: string) => ({
    ...ack,
    to: { ...ack.to, params: new Map([["tag", tag]]) },
  })

  it("accepts any ACK with a magic-cookie branch", () => {
    expect(acknowledges(tagged(request("ACK", "z9hG4bKinvite"), "x"), failure)).toBe(true)
  })

  it("compares To tags for RFC 2543 ACKs", () => {
    const legacy = request("ACK", "legacy")
    expect(acknowledges(tagged(legacy, "b1"), failure)).toBe(true)
    expect(acknowledges(tagged(legacy, "x"), failure)).toBe(false)
  })

  it("compares To tags for ACKs without any branch", () => {
    const [via] = request("ACK").via
    const bare = { ...request("ACK"), via: via ? [{ ...via, params: new Map() }] : [] }
    expect(acknowledges(tagged(bare, "b1"), failure)).toBe(true)
  })
})
