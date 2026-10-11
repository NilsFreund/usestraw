import { readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseMessage } from "../../src"
import { between, createRandom } from "../../src/simulation/random"
import { createStreamFramer, type StreamEvent } from "../../src/transport/stream"
import { bytes, fixture, register } from "../helpers"

const decoder = new TextDecoder()
const sdp = [
  "OPTIONS sip:bob@example.com SIP/2.0",
  "Via: SIP/2.0/TLS 192.0.2.10:5061;branch=z9hG4bK1",
  "Content-Type: application/sdp",
  "Content-Length: 12",
  "Call-ID: c1",
  "",
  "v=0\r\n\r\no=x\r\n",
].join("\r\n")
const head = (length: number | string, extra = "") =>
  `MESSAGE sip:b@x SIP/2.0\r\n${extra}Content-Length: ${length}\r\n\r\n`

function messages(events: StreamEvent[]): string[] {
  return events.flatMap((event) => (event.type === "message" ? [decoder.decode(event.data)] : []))
}

function types(events: StreamEvent[]): string[] {
  return events.map((event) => event.type)
}

function feed(...chunks: (string | Uint8Array)[]): StreamEvent[] {
  const framer = createStreamFramer()
  return chunks.flatMap((chunk) => framer.push(typeof chunk === "string" ? bytes(chunk) : chunk))
}

describe("createStreamFramer (RFC 3261 §18.3)", () => {
  it("cuts messages by Content-Length, with a blank line inside the body and Content-Length mid-head", () => {
    expect(messages(feed(register + sdp))).toStrictEqual([register, sdp])
  })

  it("puts messages together from chunks split at every possible byte", () => {
    const stream = `${register}\r\n\r\n${sdp}\r\n`
    for (let split = 1; split < stream.length; split++) {
      const events = feed(stream.slice(0, split), stream.slice(split))
      expect(messages(events), `split at ${split}`).toStrictEqual([register, sdp])
      expect(types(events)).not.toContain("error")
    }
  })

  it("frames every RFC 4475 message the parser accepts byte for byte", () => {
    const names = readdirSync(new URL("../fixtures/rfc4475/", import.meta.url)).map((file) =>
      file.replace(".dat", ""),
    )
    const framed = names.filter(
      (name) => !["dblreq", "inv2543"].includes(name) && parseMessage(fixture(name)).ok,
    )
    expect(framed.length).toBeGreaterThan(20)
    for (const name of framed) {
      expect(feed(fixture(name)), name).toStrictEqual([{ type: "message", data: fixture(name) }])
    }
  })

  it("closes on the second request of RFC 4475 dblreq and on inv2543, which lack Content-Length", () => {
    expect(types(feed(fixture("dblreq")))).toStrictEqual(["message", "pong", "message", "error"])
    expect(feed(fixture("inv2543"))).toStrictEqual([
      { type: "error", error: "Missing Content-Length on a stream" },
    ])
  })

  it("waits for the rest of the head and the body", () => {
    const framer = createStreamFramer()
    expect(framer.push(bytes(sdp.slice(0, 40)))).toStrictEqual([])
    expect(framer.buffered).toBe(40)
    expect(framer.push(bytes(sdp.slice(40, -3)))).toStrictEqual([])
    expect(messages(framer.push(bytes(sdp.slice(-3))))).toStrictEqual([sdp])
    expect(framer.buffered).toBe(0)
  })

  it.each([
    ["the compact form", "MESSAGE sip:b@x SIP/2.0\r\nl: 2\r\n\r\nhi"],
    ["any case", "MESSAGE sip:b@x SIP/2.0\r\nCONTENT-length: 2\r\n\r\nhi"],
    ["tabs and spaces around the colon", "MESSAGE sip:b@x SIP/2.0\r\nl\t:   2 \r\n\r\nhi"],
    ["bare LF line endings", "MESSAGE sip:b@x SIP/2.0\nl: 2\n\nhi"],
    [
      "a late Content-Length",
      `MESSAGE sip:b@x SIP/2.0\r\n${"X-Pad: x\r\n".repeat(400)}l: 2\r\n\r\nhi`,
    ],
    [
      "a repeated identical Content-Length",
      "MESSAGE sip:b@x SIP/2.0\r\nl: 2\r\nContent-Length: 2\r\n\r\nhi",
    ],
    [
      "a lone CR that the parser keeps inside a header",
      "MESSAGE sip:b@x SIP/2.0\r\nX-Foo: a\rl: 5\r\nl: 2\r\n\r\nhi",
    ],
  ])("understands %s", (_, message) => {
    expect(messages(feed(message))).toStrictEqual([message])
  })

  it.each([["X-Content-Length: 9\r\nl: 2"], ["Subject: total l: 9\r\nl: 2"]])(
    "only counts the Content-Length header itself in %j",
    (lines) => {
      const message = `MESSAGE sip:b@x SIP/2.0\r\n${lines}\r\n\r\nhi`
      expect(messages(feed(message))).toStrictEqual([message])
    },
  )

  it("frames a head with invalid UTF-8 and leaves the verdict to the parser", () => {
    const message = Uint8Array.of(
      ...bytes("MESSAGE sip:b@x SIP/2.0\r\nX: "),
      0xff,
      0xfe,
      ...bytes("\r\nl: 0\r\n\r\n"),
    )
    expect(feed(message)).toStrictEqual([{ type: "message", data: message }])
  })

  it("copies the bytes so a reused read buffer cannot change a message", () => {
    const framer = createStreamFramer()
    const chunk = bytes(register)
    const [event] = framer.push(chunk)
    chunk.fill(0)
    expect(event?.type === "message" && decoder.decode(event.data)).toBe(register)
  })

  it("frames thousands of messages from one large chunk", () => {
    const message = `${head(2)}hi`
    const events = feed(message.repeat(3000))
    expect(events).toHaveLength(3000)
    expect(new Set(messages(events))).toStrictEqual(new Set([message]))
  })

  it("accepts a message of exactly 65535 bytes, also after a leading LF", () => {
    const length = 65_535 - head(60_000).length
    const message = head(length) + "x".repeat(length)
    expect(message).toHaveLength(65_535)
    expect(messages(feed(message))).toStrictEqual([message])
    expect(messages(feed(`\n${message}`))).toStrictEqual([message])
  })

  it("waits for a head of up to 65535 bytes", () => {
    const prefix = "MESSAGE sip:b@x SIP/2.0\r\nX: "
    const framer = createStreamFramer()
    expect(framer.push(bytes(prefix + "x".repeat(65_535 - prefix.length)))).toStrictEqual([])
    expect(framer.push(bytes("x"))).toStrictEqual([
      { type: "error", error: "Message exceeds 65535 bytes" },
    ])
  })
})

describe("framing errors close the stream", () => {
  it.each([
    [
      "no Content-Length",
      "MESSAGE sip:b@x SIP/2.0\r\nCall-ID: c\r\n\r\n",
      "Missing Content-Length on a stream",
    ],
    [
      "a folded Content-Length",
      "MESSAGE sip:b@x SIP/2.0\r\nContent-Length:\r\n 2\r\n\r\nhi",
      'Invalid Content-Length ""',
    ],
    ["trailing garbage", head("5abc"), 'Invalid Content-Length "5abc"'],
    ["two numbers", head("1 2"), 'Invalid Content-Length "1 2"'],
    ["a negative length", head(-1), 'Invalid Content-Length "-1"'],
    ["a signed length", head("+5"), 'Invalid Content-Length "+5"'],
    ["conflicting lengths", head(2, "l: 1\r\nl: 1\r\n"), "Conflicting Content-Length headers"],
    ["a body above the limit", head(65_535), "Message exceeds 65535 bytes"],
  ])("reports %s", (_, stream, error) => {
    expect(feed(stream)).toStrictEqual([{ type: "error", error }])
  })

  it("delivers the messages before the broken one and ignores everything after it", () => {
    const framer = createStreamFramer()
    const events = framer.push(bytes(`${register}MESSAGE sip:b@x SIP/2.0\r\n\r\n${sdp}`))
    expect(types(events)).toStrictEqual(["message", "error"])
    expect(framer.push(bytes(register))).toStrictEqual([])
  })
})

describe("CR/LF keepalives (RFC 3261 §7.5, RFC 5626 §3.5.1)", () => {
  it.each([
    ["\r\n\r\n", ["ping"]],
    ["\r\n", ["pong"]],
    ["\r\n\r\n\r\n", ["ping"]],
    ["\n\n\n", []],
    ["\r\n\n", ["pong"]],
  ])("reports %j as %j", (stream, expected) => {
    expect(types(feed(stream))).toStrictEqual(expected)
  })

  it("waits when a run ends in CR", () => {
    const framer = createStreamFramer()
    expect(framer.push(bytes("\r\n\r"))).toStrictEqual([])
    expect(framer.push(bytes("\n"))).toStrictEqual([{ type: "ping" }])
  })

  it("takes CRLFs that arrive apart for pongs, which a server sends to our pings", () => {
    expect(types(feed("\r\n", "\r\n"))).toStrictEqual(["pong", "pong"])
  })

  it("counts separate CRLF runs between messages separately", () => {
    expect(types(feed(`\r\n${register}\r\n\r\n${sdp}\n\n`))).toStrictEqual([
      "pong",
      "message",
      "ping",
      "message",
    ])
  })

  it("skips bare LF runs before a message (RFC 3261 §7.5)", () => {
    expect(types(feed(`\n\n${register}`, `\n\r\n${sdp}`))).toStrictEqual([
      "message",
      "pong",
      "message",
    ])
  })

  it("reports a pong at once even when the following message is still incomplete", () => {
    expect(feed("\r\nMESSAGE sip:b@x SIP/2.0\r")).toStrictEqual([{ type: "pong" }])
  })

  it.each([
    ["a ping", ["\r\n\r\n", "\r\n"], ["ping", "pong"]],
    ["a bare LF run", ["\r\n", "\n\n"], ["pong"]],
    ["a message", [`\r\n${register}`, "\r\n"], ["pong", "message", "pong"]],
  ])("does not join a CRLF with the one before %s", (_, chunks, expected) => {
    expect(types(feed(...chunks))).toStrictEqual(expected)
  })

  it("finds the next message after a long run of CRs that waited for its LF", () => {
    const message = `${head(2)}hi`
    expect(types(feed("\r".repeat(100), `\n${message}`))).toStrictEqual(["pong", "message"])
  })

  it("treats a CRLF followed by a lone CR and more bytes as pong", () => {
    expect(feed("\r\n\rX")).toStrictEqual([{ type: "pong" }])
  })
})

describe("random streams", () => {
  it("reassembles random messages, bodies and keepalives from random chunks", () => {
    const random = createRandom(5626)
    const separators = ["", "\r\n", "\r\n\r\n", "\n\n", "\r\n\n"]
    for (let round = 0; round < 300; round++) {
      const sent: string[] = []
      let stream = ""
      for (let index = between(random, 1, 8); index > 0; index--) {
        const body =
          ["", "x", "\r\n", "\r\n\r\n", "ä\r\n"][between(random, 0, 4)]?.repeat(
            between(random, 0, 40),
          ) ?? ""
        const length = new TextEncoder().encode(body).length
        const name = ["Content-Length", "l", "CONTENT-LENGTH"][between(random, 0, 2)]
        const eol = random() < 0.2 ? "\n" : "\r\n"
        const message = `MESSAGE sip:b@x SIP/2.0${eol}${name}: ${length}${eol}Call-ID: c${round}${eol}${eol}${body}`
        stream += (separators[between(random, 0, separators.length - 1)] ?? "") + message
        sent.push(message)
      }
      const data = new TextEncoder().encode(stream)
      const framer = createStreamFramer()
      const received: StreamEvent[] = []
      for (let at = 0; at < data.length; ) {
        const size = between(random, 1, 5000)
        received.push(...framer.push(data.subarray(at, at + size)))
        at += size
      }
      expect(messages(received)).toStrictEqual(sent)
      expect(types(received)).not.toContain("error")
    }
  })
})
