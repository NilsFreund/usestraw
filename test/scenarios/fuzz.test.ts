import { describe, expect, it } from "vitest"
import { type Address, createCore, isRequest, type Output, parseMessage } from "../../src"
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

function sends(outputs: Output[]): Uint8Array[] {
  return outputs.flatMap((output) => (output.type === "send" ? [output.data] : []))
}

describe("fuzzing the core with mutated torture messages", () => {
  it("never throws, answers each request once and identically for every copy", () => {
    const random = createRandom(4475)
    const core = createCore({ address: alice, aor: "sip:alice@example.com", random })
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
})
