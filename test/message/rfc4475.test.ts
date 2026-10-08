import { describe, expect, it } from "vitest"
import { getHeader, isRequest, parseMessage, serializeMessage } from "../../src"
import { fixture, parsed } from "../helpers"

const valid = [
  "wsinv",
  "intmeth",
  "esc01",
  "escnull",
  "esc02",
  "lwsdisp",
  "longreq",
  "dblreq",
  "semiuri",
  "transports",
  "mpart01",
  "unreason",
  "noreason",
  "badbranch",
  "unkscm",
  "novelsc",
  "unksm2",
  "bext01",
  "invut",
  "regaut01",
  "bcast",
  "zeromf",
  "cparam01",
  "cparam02",
  "regescrt",
  "sdp01",
  "inv2543",
]

const invalid = {
  badinv01: "Invalid parameter",
  clerr: "Content-Length exceeds message size",
  ncl: "Invalid Content-Length",
  scalar02: "Invalid CSeq",
  scalarlg: "Invalid CSeq",
  quotbal: "Unterminated quoted string",
  ltgtruri: "Invalid Request-URI",
  lwsruri: "Invalid request line",
  lwsstart: "Invalid request line",
  trws: "Invalid request line",
  escruri: "Invalid Request-URI",
  baddate: "Invalid Date",
  regbadct: "Invalid address",
  badaspec: "Invalid URI",
  baddn: "Missing empty line after headers",
  badvers: "Unsupported SIP version",
  mismatch01: "does not match",
  mismatch02: "does not match",
  bigcode: "Invalid status code",
  insuf: "Missing From header",
  multi01: "Multiple From headers",
  mcl01: "Multiple Content-Length headers",
}

describe("RFC 4475 torture tests", () => {
  it.each(valid)("accepts %s", (name) => {
    expect(parseMessage(fixture(name))).toMatchObject({ ok: true })
  })

  it.each(valid)("round-trips %s", (name) => {
    const message = parsed(fixture(name))
    expect(parseMessage(serializeMessage(message))).toEqual({ ok: true, message })
  })

  it.each(Object.entries(invalid))("rejects %s", (name, reason) => {
    expect(parseMessage(fixture(name))).toEqual({
      ok: false,
      error: expect.stringContaining(reason),
    })
  })

  it("unfolds the tortuous wsinv INVITE", () => {
    const message = parsed(fixture("wsinv"))
    expect(message).toMatchObject({
      method: "INVITE",
      uri: "sip:vivekg@chair-dnrc.example.com;unknownparam",
      from: { displayName: 'J Rosenberg \\"', uri: "sip:jdrosen@example.com" },
      to: { uri: "sip:vivekg@chair-dnrc.example.com" },
      callId: "wsinv.ndaksdj@192.0.2.1",
      cseq: { seq: 9, method: "INVITE" },
      maxForwards: 68,
    })
    expect(message.from.params.get("tag")).toBe("98asjd8")
    expect(message.to.params.get("tag")).toBe("1918181833n")
    expect(message.via.map((via) => [via.transport, via.host, via.params.get("branch")])).toEqual([
      ["UDP", "192.0.2.2", "390skdjuw"],
      ["TCP", "spindle.example.com", "z9hG4bK9ikj8"],
      ["UDP", "192.168.255.111", "z9hG4bK30239"],
    ])
    expect(message.contact).toEqual([
      {
        displayName: 'Quoted string ""',
        uri: "sip:jdrosen@example.com",
        params: new Map([
          ["newparam", "newvalue"],
          ["secondparam", null],
          ["q", "0.33"],
        ]),
      },
    ])
    expect(getHeader(message, "Subject")).toBe("")
    expect(getHeader(message, "newfangledheader")).toBe(
      "newfangled value continued newfangled value",
    )
    expect(message.body).toHaveLength(150)
  })

  it("keeps the unusual intmeth method and Call-ID intact", () => {
    const message = parsed(fixture("intmeth"))
    expect(isRequest(message) && message.method).toBe("!interesting-Method0123456789_*+`.%indeed'~")
    expect(message.callId).toBe("intmeth.word%ZK-!.*_+'@word`~)(><:\\/\"][?}{")
    expect(message.to.displayName).toBe("BEL:\x07 NUL:\x00 DEL:\x7f")
  })

  it("ignores octets after Content-Length in dblreq", () => {
    expect(parsed(fixture("dblreq")).body).toHaveLength(0)
  })

  it("keeps binary multipart bodies byte-exact in mpart01", () => {
    const data = fixture("mpart01")
    expect(parsed(fixture("mpart01")).body).toEqual(data.subarray(data.length - 553))
  })
})
