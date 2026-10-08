import { describe, expect, it } from "vitest"
import { parseMessage } from "../../src"
import { parsed, register } from "../helpers"

describe("parseMessage", () => {
  it("parses a REGISTER request", () => {
    const message = parsed(register)
    expect(message).toMatchObject({
      method: "REGISTER",
      uri: "sip:example.com",
      via: [{ transport: "UDP", host: "192.0.2.1", port: 5060 }],
      maxForwards: 70,
      from: { displayName: "Bob", uri: "sip:bob@example.com" },
      to: { displayName: "Bob", uri: "sip:bob@example.com" },
      callId: "843817637684230@998sdasdh09",
      cseq: { seq: 1826, method: "REGISTER" },
      headers: [{ name: "Supported", value: "path, outbound" }],
    })
    expect(message.contact).toEqual([
      { uri: "sip:bob@192.0.2.4", params: new Map([["expires", "7200"]]) },
    ])
  })

  it("parses a response with an empty reason phrase", () => {
    const response = register.replace("REGISTER sip:example.com SIP/2.0", "SIP/2.0 100 ")
    expect(parsed(response)).toMatchObject({ status: 100, reason: "" })
  })

  it("expands compact header names", () => {
    const message = parsed(
      [
        "OPTIONS sip:bob@example.com SIP/2.0",
        "v: SIP/2.0/TCP client.example.com;branch=z9hG4bKnashds7",
        "f: <sip:alice@example.com>;tag=1928301774",
        "t: <sip:bob@example.com>",
        "i: a84b4c76e66710",
        "CSeq: 63104 OPTIONS",
        "m: <sip:alice@client.example.com>",
        "c: application/sdp",
        "l: 0",
        "",
        "",
      ].join("\r\n"),
    )
    expect(message.callId).toBe("a84b4c76e66710")
    expect(message.contact).toHaveLength(1)
    expect(message.headers).toEqual([{ name: "Content-Type", value: "application/sdp" }])
  })

  it("accepts bare LF line endings and leading keep-alive CRLFs", () => {
    expect(parsed(`\r\n\r\n${register.replaceAll("\r\n", "\n")}`).callId).toBe(
      "843817637684230@998sdasdh09",
    )
  })

  it("takes the rest of the datagram as body without Content-Length", () => {
    const message = parsed(`${register.replace("Content-Length: 0\r\n", "")}hello`)
    expect(new TextDecoder().decode(message.body)).toBe("hello")
  })

  it("rejects a CSeq method that differs from the request method", () => {
    expect(parseMessage(register.replace("1826 REGISTER", "1826 INVITE"))).toEqual({
      ok: false,
      error: "CSeq method INVITE does not match REGISTER",
    })
  })

  it("rejects Max-Forwards above 255", () => {
    expect(parseMessage(register.replace("Max-Forwards: 70", "Max-Forwards: 256"))).toEqual({
      ok: false,
      error: 'Invalid Max-Forwards "256"',
    })
  })

  it("rejects display names with non-token characters", () => {
    expect(parseMessage(register.replace("To: Bob", "To: Bob, Builder"))).toEqual({
      ok: false,
      error: 'Invalid display name "Bob, Builder"',
    })
  })
})
