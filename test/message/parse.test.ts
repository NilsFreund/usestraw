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

  it.each(["0x46", "7e1", "70.0"])("rejects the Max-Forwards %s", (value) => {
    expect(parseMessage(register.replace("Max-Forwards: 70", `Max-Forwards: ${value}`))).toEqual({
      ok: false,
      error: `Invalid Max-Forwards "${value}"`,
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

  const via = "Via: SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK776asdhds;rport\r\n"

  it.each([
    ["SIP/2.0 OK", 'Invalid status line "SIP/2.0 OK"'],
    ["INV@ITE sip:example.com SIP/2.0", 'Invalid method "INV@ITE"'],
  ])("rejects the start line %s", (line, error) => {
    const message = register.replace("REGISTER sip:example.com SIP/2.0", line)
    expect(parseMessage(message)).toEqual({ ok: false, error })
  })

  it.each([
    ["a continuation line before any header", via, ` ${via}`, "Header continuation without header"],
    [
      "a header line without colon",
      "Max-Forwards: 70",
      "Max-Forwards 70",
      'Invalid header line "Max-Forwards 70"',
    ],
    ["a missing Via", via, "", "Missing Via header"],
    [
      "a Call-ID with whitespace",
      "Call-ID: 843817637684230@998sdasdh09",
      "Call-ID: a b",
      'Invalid Call-ID "a b"',
    ],
    ["an empty Call-ID", "Call-ID: 843817637684230@998sdasdh09", "Call-ID:", 'Invalid Call-ID ""'],
    ["a duplicate Call-ID", "CSeq:", "Call-ID: second\r\nCSeq:", "Multiple Call-ID headers"],
  ])("rejects %s", (_, search, replacement, error) => {
    expect(parseMessage(register.replace(search, replacement))).toEqual({ ok: false, error })
  })

  it.each([
    ["SIP/2.0 700 Weird", 'Invalid status code "700"'],
    ["SIP/2.0 099 Low", 'Invalid status code "099"'],
    ["SIP/2.0 0200 OK", 'Invalid status code "0200"'],
    ["SIP/2.0 200 OK\x00", "Invalid character in reason phrase"],
    ["SIP/2.0 200 O\rK", "Invalid character in reason phrase"],
  ])("rejects the status line %j", (line, error) => {
    const message = register.replace("REGISTER sip:example.com SIP/2.0", line)
    expect(parseMessage(message)).toEqual({ ok: false, error })
  })

  it("accepts a lowercase SIP version", () => {
    expect(parsed(register.replace("SIP/2.0\r\n", "sip/2.0\r\n"))).toMatchObject({
      method: "REGISTER",
    })
    const response = register.replace("REGISTER sip:example.com SIP/2.0", "sip/2.0 200 OK")
    expect(parsed(response)).toMatchObject({ status: 200 })
  })

  it("keeps a reason phrase with a line separator", () => {
    const response = register.replace("REGISTER sip:example.com SIP/2.0", "SIP/2.0 200 O\u2028K")
    expect(parsed(response)).toMatchObject({ reason: "O\u2028K" })
  })

  it("keeps header values with line and paragraph separators", () => {
    const message = parsed(
      register.replace("Supported: path, outbound", "Subject: a\u2028b\u2029c"),
    )
    expect(message.headers).toEqual([{ name: "Subject", value: "a\u2028b\u2029c" }])
  })

  it("rejects a Content-Length with trailing garbage", () => {
    expect(parseMessage(register.replace("Content-Length: 0", "Content-Length: 5abc"))).toEqual({
      ok: false,
      error: 'Invalid Content-Length "5abc"',
    })
  })

  it.each([
    ["a NUL in a header value", "Subject: a\x00b", "Invalid character in Subject header"],
    ["an escape character", "Subject: \x1b[31mred", "Invalid character in Subject header"],
    ["a DEL character", "Subject: a\x7fb", "Invalid character in Subject header"],
    ["a lone CR", "Subject: a\rX-Injected: yes", "Invalid character in Subject header"],
    ["a lone CR in a folded line", "Subject: a\r\n b\rc", "Invalid character in Subject header"],
    ["a NUL in the Call-ID", "Call-ID: a\x00b", "Invalid character in Call-ID header"],
    ["a NUL in a URI", "Contact: <sip:bob@192.0.2.4\x00>", "Invalid character in Contact header"],
  ])("rejects %s", (_, header, error) => {
    const message = register.replace("Supported: path, outbound", header)
    expect(parseMessage(message)).toEqual({ ok: false, error })
  })

  it("rejects an escaped control character in the Call-ID", () => {
    const message = register.replace("Call-ID: 843817637684230@998sdasdh09", 'Call-ID: "\\\x00"')
    expect(parseMessage(message)).toEqual({
      ok: false,
      error: 'Invalid Call-ID "\\"\\\\\\u0000\\""',
    })
  })

  it("quotes and escapes invalid values in errors", () => {
    const message = register.replace("Supported: path, outbound", 'Date: "x\\y"')
    expect(parseMessage(message)).toEqual({ ok: false, error: 'Invalid Date "\\"x\\\\y\\""' })
  })

  it("rejects a NUL in the Request-URI", () => {
    const message = register.replace("sip:example.com", "sip:exa\x00mple.com")
    expect(parseMessage(message)).toEqual({
      ok: false,
      error: 'Invalid Request-URI "sip:exa\\u0000mple.com"',
    })
  })

  it("keeps escaped control characters inside quoted strings", () => {
    const message = parsed(register.replace("To: Bob", 'To: "NUL:\\\x00 DEL:\\\x7f"'))
    expect(message.to.displayName).toBe("NUL:\x00 DEL:\x7f")
  })

  it("accepts messages of exactly 65535 bytes and rejects larger ones", () => {
    expect(sized(65_535)).toHaveLength(65_535)
    expect(parseMessage(sized(65_535))).toMatchObject({ ok: true })
    expect(parseMessage(sized(65_536))).toEqual({
      ok: false,
      error: "Message exceeds 65535 bytes",
    })
  })

  it("accepts 256 header lines and rejects more", () => {
    const head = register.split("\r\n").slice(0, 9)
    const message = (lines: number) =>
      [...head, ...Array.from({ length: lines - 8 }, (_, i) => `X-${i}: ${i}`), "", ""].join("\r\n")
    expect(parseMessage(message(256))).toMatchObject({ ok: true })
    expect(parseMessage(message(257))).toEqual({
      ok: false,
      error: "Too many header lines (limit 256)",
    })
  })

  it("lets programming errors escape instead of hiding them as parse errors", () => {
    expect(() => parseMessage(undefined as unknown as string)).toThrow(TypeError)
  })
})

function sized(total: number): string {
  const head = (length: number) =>
    register.replace("Content-Length: 0", `Content-Length: ${length}`)
  const length = total - head(10_000).length
  return head(length) + "x".repeat(length)
}
