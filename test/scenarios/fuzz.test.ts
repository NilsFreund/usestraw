import { describe, expect, it } from "vitest"
import {
  type Address,
  type Command,
  createCore,
  isRequest,
  type Output,
  parseMessage,
} from "../../src"
import { between, createRandom } from "../../src/simulation/random"
import { alice, bob, fixture } from "../helpers"

const BASES = ["wsinv", "intmeth", "esc01", "lwsdisp", "semiuri", "unreason", "bext01", "unkscm"]
const SPICE = [
  '"',
  "\\",
  "\x00",
  "\x1b",
  "\x7f",
  "\x85",
  "\u2028",
  "\r",
  "\n",
  "\r\n",
  "\t",
  ",",
  ";",
  "<",
  ">",
  ":",
  "=",
  "%",
  "[",
  " ",
  '"\\\x00"',
  "\\\x1b",
  "\\\r",
  '"a\\"b"',
]
const SOURCES: Address[] = [
  bob,
  { transport: "UDP", host: "2001:db8::20", port: 5060 },
  { transport: "UDP", host: "fe80::2%en0", port: 40_000 },
  { transport: "TCP", host: "192.0.2.21", port: 50_000 },
  { transport: "TLS", host: "192.0.2.22", port: 5061 },
  { transport: "WSS", host: "198.51.100.7", port: 443 },
]
const decoder = new TextDecoder()
const encoder = new TextEncoder()

function mutateText(text: string, random: () => number): Uint8Array {
  let mutated = text
  for (let edit = between(random, 1, 4); edit > 0; edit--) {
    const at = between(random, 0, mutated.length)
    const spice = SPICE[between(random, 0, SPICE.length - 1)] ?? ""
    mutated =
      random() < 0.7
        ? mutated.slice(0, at) + spice + mutated.slice(at)
        : mutated.slice(0, at) + mutated.slice(at + 1)
  }
  return encoder.encode(mutated)
}

function mutateBytes(text: string, random: () => number): Uint8Array {
  const bytes = encoder.encode(text)
  for (let edit = between(random, 1, 3); edit > 0; edit--) {
    bytes[between(random, 0, bytes.length - 1)] = between(random, 0, 255)
  }
  return bytes
}

function invite(round: number): string {
  return [
    "INVITE sip:alice@192.0.2.10 SIP/2.0",
    `Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bKfuzz${round};rport`,
    "Max-Forwards: 70",
    'From: "Bob" <sip:bob@example.com>;tag=fuzz',
    "To: <sip:alice@example.com>",
    `Call-ID: fuzz-${round}@example.com`,
    "CSeq: 1 INVITE",
    "Contact: <sip:bob@192.0.2.20:5060>",
    "Record-Route: <sip:proxy.example.com;lr>",
    "Content-Type: application/sdp",
    "Content-Length: 5",
    "",
    "v=0\r\n",
  ].join("\r\n")
}

const METHODS = ["BYE", "ACK", "INVITE", "CANCEL", "OPTIONS", "INFO"]

function inDialog(callId: string, tag: string, random: () => number): string {
  const method = METHODS[between(random, 0, METHODS.length - 1)] ?? "BYE"
  const seq = between(random, 0, 3)
  const branch = random() < 0.3 ? "z9hG4bKfuzz0" : `z9hG4bKd${between(random, 0, 99)}`
  const body = random() < 0.5 ? "v=0\r\na=sendonly\r\n" : ""
  return [
    `${method} sip:alice@192.0.2.10:5060 SIP/2.0`,
    `Via: SIP/2.0/UDP 192.0.2.20:5060;branch=${branch};rport`,
    "Max-Forwards: 70",
    'From: "Bob" <sip:bob@example.com>;tag=fuzz',
    `To: <sip:alice@example.com>${method === "CANCEL" && random() < 0.5 ? "" : `;tag=${tag}`}`,
    `Call-ID: ${callId}`,
    `CSeq: ${seq} ${random() < 0.9 ? method : "INVITE"}`,
    "Contact: <sip:bob@192.0.2.20:5070>",
    ...(body === "" ? [] : ["Content-Type: application/sdp"]),
    `Content-Length: ${body.length}`,
    "",
    body,
  ].join("\r\n")
}

function sends(outputs: Output[]): Uint8Array[] {
  return outputs.flatMap((output) => (output.type === "send" ? [output.data] : []))
}

describe("fuzzing the core with mutated torture messages", () => {
  it("never throws, answers each request once and identically for every copy", () => {
    const random = createRandom(4475)
    const core = createCore({ address: alice, aor: "sip:alice@example.com", random, maxCalls: 0 })
    const texts = BASES.map((name) => decoder.decode(fixture(name)))
    let answered = 0
    for (let round = 0; round < 4000; round++) {
      const base = texts[round % texts.length] ?? ""
      const data = random() < 0.7 ? mutateText(base, random) : mutateBytes(base, random)
      const input = { type: "receive", data, from: SOURCES[round % SOURCES.length] ?? bob } as const
      const first = core.handle(input, round)
      expect(core.handle(input, round)).toEqual(first)
      const result = parseMessage(data)
      if (result.ok && isRequest(result.message) && result.message.method !== "ACK") {
        expect(sends(first)).toHaveLength(1)
        answered++
      }
      for (const reply of sends(first)) expect(parseMessage(reply)).toMatchObject({ ok: true })
    }
    expect(answered).toBeGreaterThan(500)
  })

  it("never throws when mutated INVITEs become calls that get in-dialog requests and time out", () => {
    const random = createRandom(3261)
    const core = createCore({ address: alice, aor: "sip:alice@example.com", random })
    const texts = BASES.map((name) => decoder.decode(fixture(name)))
    const sdp = encoder.encode("v=0\r\n")
    const dialogs: { readonly call: string; readonly tag: string }[] = []
    const seen = new Set<string>()
    let calls = 0
    for (let round = 0; round < 6000; round++) {
      const dialog = dialogs[between(random, 0, dialogs.length - 1)]
      const kind = round % 3
      const base =
        kind === 0
          ? invite(round)
          : kind === 1 && dialog
            ? inDialog(dialog.call, dialog.tag, random)
            : (texts[round % texts.length] ?? "")
      const pristine = kind === 1 && random() < 0.5
      const data = pristine
        ? encoder.encode(base)
        : random() < 0.7
          ? mutateText(base, random)
          : mutateBytes(base, random)
      const from = SOURCES[round % SOURCES.length] ?? bob
      const outputs = core.handle({ type: "receive", data, from }, round * 100)
      for (const output of outputs) {
        if (output.type === "send") {
          const result = parseMessage(output.data)
          expect(result).toMatchObject({ ok: true })
          if (result.ok && "status" in result.message) {
            seen.add(`${result.message.status} ${result.message.cseq.method}`)
          }
          if (result.ok && "status" in result.message && result.message.status === 180) {
            const tag = result.message.to.params.get("tag") ?? ""
            dialogs.push({ call: result.message.callId, tag })
          }
        }
        if (output.type !== "event" || output.event.type !== "call") continue
        if (output.event.state !== "incoming") continue
        calls++
        const command = random() < 0.8 ? { type: "accept", sdp } : { type: "end", status: 603 }
        const call = { ...command, call: output.event.call } as Command
        core.handle({ type: "command", command: call }, round * 100)
      }
      if (random() < 0.1 && dialog) {
        core.handle({ type: "command", command: { type: "end", call: dialog.call } }, round * 100)
      }
      core.handle({ type: "timeout" }, round * 100 + 50)
    }
    expect(calls).toBeGreaterThan(200)
    for (const reached of ["200 BYE", "200 CANCEL", "500 INVITE", "481 BYE", "603 INVITE"]) {
      expect(seen).toContain(reached)
    }
    for (let at = 600_000; core.nextDeadline() !== undefined && at < 2_000_000; at += 1000) {
      core.handle({ type: "timeout" }, at)
    }
    expect(core.nextDeadline()).toBeUndefined()
  })
})
