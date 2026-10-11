import { describe, expect, it } from "vitest"
import { createRecordedCore, defaultTimers, type RecordedStep, replay } from "../../src/core"
import { decode } from "../../src/recorder/codec"
import { createRandom } from "../../src/simulation/random"
import { alice, bob, bytes } from "../helpers"

const options = (seed = 1) => ({
  address: alice,
  aor: "sip:alice@example.com",
  random: createRandom(seed),
  credentials: { username: "alice", password: "very-secret", realm: "example.com" },
})

const lines = (recording: string) =>
  recording
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => decode(line) as Record<string, unknown>)

const optionsCommand = {
  type: "command",
  command: { type: "options", uri: "sip:bob@example.com", to: bob },
} as const

describe("createRecordedCore", () => {
  it("writes a header without the password and with the draws made while starting", () => {
    const timers = { t1: 10, t2: 40, t4: 50, d: 640, trying: 0 }
    const core = createRecordedCore({ ...options(), timers })
    const recording = core.recording()
    expect(recording).not.toContain("very-secret")
    expect(recording.endsWith("\n")).toBe(true)
    const [header] = lines(recording)
    expect(header).toMatchObject({
      straw: "recording",
      version: 1,
      release: "0.0.0",
      truncated: false,
      next: null,
      options: {
        address: alice,
        aor: "sip:alice@example.com",
        credentials: { username: "alice", realm: "example.com" },
        timers: { t1: 10 },
      },
    })
    expect(header?.["random"]).toStrictEqual(expect.arrayContaining([expect.any(Number)]))
  })

  it("leaves out credentials that were not given, but always writes timers and maxCalls", () => {
    const { credentials: _, ...plain } = options()
    const [header] = lines(createRecordedCore(plain).recording())
    expect(header?.["options"]).toStrictEqual({
      address: alice,
      aor: "sip:alice@example.com",
      timers: defaultTimers,
      maxCalls: 100,
    })
    const realmless = createRecordedCore({
      ...options(),
      credentials: { username: "a", password: "p" },
    })
    expect(lines(realmless.recording())[0]?.["options"]).toMatchObject({
      credentials: { username: "a" },
    })
  })

  it("keeps the header as it was at the start", () => {
    const address = { ...alice }
    const core = createRecordedCore({ ...options(), address })
    Object.assign(address, { port: 7000 })
    expect(lines(core.recording())[0]?.["options"]).toMatchObject({ address: alice })
    expect(replay(core.recording())).toMatchObject({ ok: true })
  })

  it("records each step with its time, input, draws, outputs and next deadline", () => {
    const seen: RecordedStep[] = []
    const core = createRecordedCore(options(), { onStep: (step) => seen.push(step) })
    const outputs = core.handle(optionsCommand, 1000)
    expect(core.nextDeadline()).toBe(1500)
    const [, step] = lines(core.recording())
    expect(step).toStrictEqual({
      now: 1000,
      input: optionsCommand,
      random: expect.arrayContaining([expect.any(Number)]),
      next: 1500,
      outputs,
    })
    expect(seen).toStrictEqual([step])
  })

  it("records a step that throws and throws on", () => {
    const core = createRecordedCore(options())
    const bad = {
      type: "command",
      command: { type: "options", uri: "sip:b@x?Route=evil", to: bob },
    } as const
    expect(() => core.handle(bad, 0)).toThrow(TypeError)
    const [, step] = lines(core.recording())
    expect(step).toStrictEqual({
      now: 0,
      input: bad,
      random: [],
      next: null,
      thrown: expect.stringMatching(/^TypeError: Invalid Request-URI/),
    })
  })

  it("keeps working when the step listener throws", () => {
    const core = createRecordedCore(options(), {
      onStep: () => {
        throw new Error("broken sink")
      },
    })
    expect(core.handle(optionsCommand, 0)).toHaveLength(1)
    expect(lines(core.recording())).toHaveLength(2)
    expect(replay(core.recording())).toMatchObject({ ok: true })
  })

  it("hands the listener the masked step only", () => {
    const seen: RecordedStep[] = []
    const core = createRecordedCore(options(), { onStep: (step) => seen.push(step) })
    const ok = bytes(
      [
        "SIP/2.0 200 OK",
        'Authentication-Info: rspauth="6629fae49393a05397450978507c4ef1", qop=auth',
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"),
    )
    core.handle({ type: "receive", data: ok, from: bob }, 0)
    const input = seen[0]?.input
    expect(input?.type === "receive" && new TextDecoder().decode(input.data)).toContain(
      'rspauth="masked"',
    )
  })

  it("refuses a limit it cannot honour", () => {
    for (const limit of [0, 1023, 1.5, Number.NaN, 2 ** 31]) {
      expect(() => createRecordedCore(options(), { limit })).toThrow(RangeError)
    }
  })

  it("forgets the oldest steps beyond its limit in bytes and says so", () => {
    const core = createRecordedCore(options(), { limit: 4096 })
    for (let index = 0; index < 10; index++) core.handle({ type: "timeout" }, index)
    for (let index = 0; index < 6; index++) core.handle(optionsCommand, 10 + index)
    const recording = core.recording()
    const recorded = lines(recording)
    expect(recorded[0]?.["truncated"]).toBe(true)
    expect(recorded.length - 1).toBeLessThan(16)
    expect(recorded.every((line) => !("oversized" in line))).toBe(true)
    expect(recorded.at(-1)?.["now"]).toBe(15)
    const steps = recording.split("\n").slice(1).join("\n")
    expect(new TextEncoder().encode(steps).length).toBeLessThanOrEqual(4096)
  })

  it("counts multi-byte characters as bytes", () => {
    const core = createRecordedCore(options(), { limit: 4096 })
    const body = `${"電話ü".repeat(95)}😀`
    const length = new TextEncoder().encode(body).length
    for (let index = 0; index < 5; index++) {
      const message = `MESSAGE sip:alice@example.com SIP/2.0\r\nContent-Length: ${length}\r\n\r\n${body}`
      core.handle({ type: "receive", data: bytes(message), from: bob }, index)
    }
    const recording = core.recording()
    expect(lines(recording)[0]?.["truncated"]).toBe(true)
    const steps = recording.split("\n").slice(1).join("\n")
    expect(steps.length).toBeLessThan(4096 / 2)
    expect(new TextEncoder().encode(steps).length).toBeLessThanOrEqual(4096)
  })

  it("masks a hash quoted in an error and still replays", () => {
    const core = createRecordedCore(options())
    const message = {
      method: "OPTIONS",
      uri: "sip:bob@example.com",
      via: [
        {
          transport: "UDP",
          host: "192.0.2.10",
          port: 5060,
          params: new Map([["branch", "z9hG4bK1"]]),
        },
      ],
      maxForwards: 70,
      from: { uri: "sip:alice@example.com", params: new Map([["tag", "1"]]) },
      to: { uri: "sip:bob@example.com", params: new Map() },
      callId: "c1",
      cseq: { seq: 1, method: "OPTIONS" },
      contact: [],
      headers: [{ name: "Authorization", value: 'Digest response="6629fae49393a053"\r\nX: y' }],
      body: new Uint8Array(),
    } as const
    expect(() =>
      core.handle({ type: "command", command: { type: "send", message, to: bob } }, 0),
    ).toThrow("6629fae49393a053")
    const recording = core.recording()
    expect(recording).not.toContain("6629fae49393a053")
    expect(lines(recording)[1]?.["thrown"]).toContain('response="masked"')
    expect(replay(recording)).toStrictEqual({ ok: true, steps: 1 })
  })

  it("leaves out a step too large to keep instead of forgetting everything", () => {
    const core = createRecordedCore(options(), { limit: 8192 })
    core.handle(optionsCommand, 0)
    const huge = `OPTIONS sip:alice@example.com SIP/2.0\r\nX-Pad: ${"\u0001".repeat(5000)}\r\n\r\n`
    core.handle({ type: "receive", data: bytes(huge), from: bob }, 1)
    const recorded = lines(core.recording())
    expect(recorded[0]?.["truncated"]).toBe(true)
    expect(recorded[1]?.["now"]).toBe(0)
    expect(recorded[2]).toStrictEqual({ now: 1, oversized: expect.any(Number) })
  })
})
