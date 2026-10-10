import { describe, expect, it } from "vitest"
import { type CoreOutput, createRecordedCore, ladder, type RecordedStep } from "../../src"
import { formatStep } from "../../src/recorder/ladder"
import { createRandom } from "../../src/simulation/random"
import { alice, bob, bytes } from "../helpers"

const registration = (event: object) =>
  ({ type: "event", event: { type: "registration", ...event } }) as CoreOutput

function step(fields: Partial<RecordedStep>): RecordedStep {
  return {
    now: 1234,
    input: { type: "timeout" },
    random: [],
    next: null,
    outputs: [],
    ...fields,
  } as RecordedStep
}

describe("formatStep", () => {
  it("draws what came in and what went out with the first line of each message", () => {
    const lines = formatStep(
      step({
        input: {
          type: "receive",
          data: bytes("SIP/2.0 401 Unauthorized\r\nVia: x\r\n\r\n"),
          from: bob,
        },
        outputs: [
          {
            type: "send",
            data: bytes("REGISTER sip:example.com SIP/2.0\r\n\r\n"),
            to: { ...bob, host: "2001:db8::1" },
          },
        ],
      }),
    )
    expect(lines).toStrictEqual([
      "    1.234  192.0.2.20:5060 → phone  SIP/2.0 401 Unauthorized",
      "    1.234  phone → [2001:db8::1]:5060  REGISTER sip:example.com SIP/2.0",
    ])
  })

  it("shows how the registration went", () => {
    const lines = formatStep(
      step({
        outputs: [
          registration({ state: "registered", expires: 600 }),
          registration({ state: "failed", failure: { reason: "timeout" }, retryIn: 41_600 }),
          registration({ state: "failed", failure: { reason: "unauthorized", status: 401 } }),
          registration({ state: "unregistered" }),
          { type: "event", event: { type: "invalid", error: "x", from: bob } },
        ],
      }),
    )
    expect(lines).toStrictEqual([
      "    1.234  ● online for 600 s",
      "    1.234  ● failed: timeout, retry in 42 s",
      "    1.234  ● failed: unauthorized",
      "    1.234  ● unregistered",
    ])
  })

  it("shows how calls go", () => {
    const media = {
      remote: { host: "192.0.2.20", port: 4000 },
      codec: "PCMA",
      payloadType: 8,
      ptime: 20,
      direction: "sendrecv",
    }
    const call = (event: Record<string, unknown>) =>
      ({ type: "event", event: { type: "call", call: "c1", ...event } }) as CoreOutput
    const lines = formatStep(
      step({
        outputs: [
          call({
            state: "incoming",
            from: { uri: "sip:bob@example.com", name: "Bob" },
            to: { uri: "sip:alice@example.com" },
            source: bob,
          }),
          call({ state: "ringing", status: 180 }),
          call({
            state: "ringing",
            status: 183,
            media: { ...media, remote: { host: "192.0.2.20", port: 5004 } },
          }),
          call({ state: "live" }),
          call({ state: "live", media }),
          call({
            state: "live",
            media: { ...media, remote: { host: "2001:db8::5", port: 4000 }, direction: "recvonly" },
          }),
          call({ state: "ended", ended: { by: "remote", reason: "busy", status: 486 } }),
          call({ state: "ended", ended: { by: "local", reason: "hangup" } }),
        ],
      }),
    )
    expect(lines).toStrictEqual([
      "    1.234  ● call incoming from sip:bob@example.com",
      "    1.234  ● call ringing 180",
      "    1.234  ● call ringing 183 PCMA to 192.0.2.20:5004",
      "    1.234  ● call live",
      "    1.234  ● call live PCMA to 192.0.2.20:4000",
      "    1.234  ● call live PCMA to [2001:db8::5]:4000 recvonly",
      "    1.234  ● call ended by remote: busy 486",
      "    1.234  ● call ended by local: hangup",
    ])
  })

  it("draws nothing for a quiet timer and shows a step that threw", () => {
    expect(formatStep(step({}))).toStrictEqual([])
    const { outputs: _, ...thrown } = step({ thrown: 'TypeError: Invalid Request-URI "x"' })
    expect(formatStep(thrown)).toStrictEqual(['    1.234  ✗ TypeError: Invalid Request-URI "x"'])
  })

  it("cannot be used to send escape sequences to the terminal", () => {
    const evil = `SIP/2.0 200 \u001b[2J\u202eOK ${"x".repeat(200)}`
    const [line] = formatStep(step({ input: { type: "receive", data: bytes(evil), from: bob } }))
    expect(line).not.toContain(String.fromCodePoint(0x1b))
    expect(line).not.toContain(String.fromCodePoint(0x202e))
    expect(line).toContain("\\u{1b}[2J\\u{202e}OK")
    expect(line?.endsWith("…")).toBe(true)
    expect(line?.length).toBeLessThanOrEqual(160)
  })
})

describe("ladder", () => {
  it("draws a whole recording", () => {
    const core = createRecordedCore({
      address: alice,
      aor: "sip:alice@example.com",
      random: createRandom(1),
    })
    core.handle(
      { type: "command", command: { type: "options", uri: "sip:bob@example.com", to: bob } },
      0,
    )
    core.handle({ type: "timeout" }, 500)
    expect(ladder(core.recording()).split("\n")).toStrictEqual([
      "    0.000  phone → 192.0.2.20:5060  OPTIONS sip:bob@example.com SIP/2.0",
      "    0.500  phone → 192.0.2.20:5060  OPTIONS sip:bob@example.com SIP/2.0",
    ])
  })

  it("cannot be used against whoever opens someone else's recording", () => {
    const esc = "\u001b]0;owned\u0007"
    const head =
      '{"straw":"recording","version":1,"options":{},"random":[],"next":null,"truncated":false}'
    const crafted = [
      head,
      JSON.stringify({
        now: 0,
        input: { type: "timeout" },
        random: [],
        next: null,
        outputs: [
          { type: "event", event: { type: "registration", state: "registered", expires: esc } },
        ],
      }),
      JSON.stringify({
        now: 1,
        input: { type: "timeout" },
        random: [],
        next: null,
        outputs: [
          {
            type: "event",
            event: { type: "registration", state: "failed", failure: { reason: esc } },
          },
        ],
      }),
      JSON.stringify({
        now: 2,
        input: { type: "receive", data: { $text: "x" }, from: { host: esc, port: esc } },
        random: [],
        next: null,
        outputs: [],
      }),
      "{not json",
      `${"[".repeat(100_000)}${"]".repeat(100_000)}`,
      JSON.stringify({ now: 3, input: null, random: [], next: null, outputs: [] }),
      JSON.stringify({ now: 4000, oversized: 300_000 }),
    ].join("\n")
    const drawn = ladder(crafted)
    expect(drawn).not.toContain(String.fromCodePoint(0x1b))
    expect(drawn).not.toContain(String.fromCodePoint(0x07))
    expect(drawn.split("\n")).toStrictEqual([
      "    0.000  ● online for \\u{1b}]0;owned\\u{7} s",
      "    0.001  ● failed: \\u{1b}]0;owned\\u{7}",
      "    0.002  \\u{1b}]0;owned\\u{7}:\\u{1b}]0;owned\\u{7} → phone  x",
      "          ✗ unreadable step",
      "          ✗ unreadable step",
      "          ✗ unreadable step",
      "    4.000  … a step of 293 KiB was left out",
    ])
  })
})
