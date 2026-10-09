import { describe, expect, it } from "vitest"
import { createAck } from "../../src/transaction/ack"
import { request, response } from "./support"

describe("createAck (RFC 3261 §17.1.1.3)", () => {
  const invite = request("INVITE", "z9hG4bKinvite", [
    "Route: <sip:proxy.example.com;lr>",
    "Subject: lunch",
  ])

  it("acknowledges a failure within the INVITE transaction", () => {
    const failure = response(invite, 486, "busy")
    expect(createAck(invite, failure)).toEqual({
      method: "ACK",
      uri: invite.uri,
      via: invite.via,
      maxForwards: 70,
      from: invite.from,
      to: failure.to,
      callId: invite.callId,
      cseq: { seq: invite.cseq.seq, method: "ACK" },
      contact: [],
      headers: [{ name: "Route", value: "<sip:proxy.example.com;lr>" }],
      body: new Uint8Array(),
    })
  })

  it("keeps only the top Via", () => {
    const proxied = { ...invite, via: [...invite.via, ...invite.via] }
    expect(createAck(proxied, response(invite, 486)).via).toHaveLength(1)
  })
})
