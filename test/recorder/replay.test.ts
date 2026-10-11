import { describe, expect, it } from "vitest"
import { createRecordedCore, type RecordedCore, replay } from "../../src"
import { decode, encode } from "../../src/recorder/codec"
import { latency, loss } from "../../src/simulation/network/conditions"
import { createRandom } from "../../src/simulation/random"
import { createSimulation } from "../../src/simulation/simulation"
import { alice, bob, bytes, sdp } from "../helpers"
import { registrar } from "../registrar"

const credentials = { username: "alice", password: "secret" }

function recordRegistration(seed: number, lossRate: number): RecordedCore {
  const simulation = createSimulation({
    seed,
    internet: { latency: latency.uniform(10, 80), loss: loss.random(lossRate), duplicate: 0.1 },
  })
  let recorded: RecordedCore | undefined
  const phone = simulation.addNode("phone", alice, (random) => {
    recorded = createRecordedCore({
      address: alice,
      aor: "sip:alice@example.com",
      random,
      credentials,
    })
    return recorded
  })
  simulation.addNode("registrar", bob, registrar({ algorithm: "SHA-256" }))
  simulation.command(phone, { type: "register", to: bob, expires: 120 })
  simulation.at(200_000, () => simulation.command(phone, { type: "unregister" }))
  simulation.run(400_000)
  if (!recorded) throw new Error("No phone")
  return recorded
}

function rewrite(
  recording: string,
  index: number,
  change: (step: Record<string, unknown>) => unknown,
) {
  const lines = recording.split("\n")
  lines[index] = encode(change(decode(lines[index] ?? "") as Record<string, unknown>))
  return lines.join("\n")
}

describe("replay", () => {
  it("replays registrations through loss, duplicates and refreshes byte for byte", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const recording = recordRegistration(seed, 0.3).recording()
      const result = replay(recording)
      expect(result, `seed ${seed}`).toMatchObject({ ok: true })
      expect(result.ok && result.steps, `seed ${seed}`).toBeGreaterThan(5)
    }
  })

  it("replays stateless answers, invalid input and a step that threw", () => {
    const core = createRecordedCore({
      address: alice,
      aor: "sip:alice@example.com",
      random: createRandom(5),
    })
    const options = [
      "OPTIONS sip:alice@example.com SIP/2.0",
      "Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bK1",
      "From: <sip:bob@example.com>;tag=b1",
      "To: <sip:alice@example.com>",
      "Call-ID: c1",
      "CSeq: 1 OPTIONS",
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n")
    core.handle({ type: "receive", data: bytes(options), from: bob }, 0)
    core.handle({ type: "receive", data: new Uint8Array([0xff, 0xfe]), from: bob }, 1)
    expect(() =>
      core.handle({ type: "command", command: { type: "options", uri: "bad uri", to: bob } }, 2),
    ).toThrow()
    core.handle(
      { type: "command", command: { type: "options", uri: "sip:bob@example.com", to: bob } },
      3,
    )
    core.handle({ type: "timeout" }, 40_000)
    expect(replay(core.recording())).toStrictEqual({ ok: true, steps: 5 })
  })

  it("replays a phone that turns calls away with its own maxCalls and acceptFrom", () => {
    const core = createRecordedCore({
      address: alice,
      aor: "sip:alice@example.com",
      random: createRandom(5),
      maxCalls: 0,
      timers: { t1: 100 },
      acceptFrom: ["192.0.2.20"],
    })
    const body = sdp()
    const invite = [
      "INVITE sip:alice@example.com SIP/2.0",
      "Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bK1",
      "Max-Forwards: 70",
      "From: <sip:bob@example.com>;tag=b1",
      "To: <sip:alice@example.com>",
      "Call-ID: c1",
      "CSeq: 1 INVITE",
      "Contact: <sip:bob@192.0.2.20>",
      "Content-Type: application/sdp",
      `Content-Length: ${body.length}`,
      "",
      body,
    ].join("\r\n")
    const outputs = core.handle({ type: "receive", data: bytes(invite), from: bob }, 0)
    expect(outputs).toContainEqual(
      expect.objectContaining({ event: expect.objectContaining({ status: 486 }) }),
    )
    const probe = bytes(invite.replace("branch=z9hG4bK1", "branch=z9hG4bK2"))
    core.handle({ type: "receive", data: probe, from: { ...bob, host: "203.0.113.9" } }, 1)
    expect(replay(core.recording())).toStrictEqual({ ok: true, steps: 2 })
  })

  it("points at the first step that does not match", () => {
    const recording = recordRegistration(1, 0).recording()
    const changed = rewrite(recording, 3, (step) => ({ ...step, now: (step["now"] as number) + 1 }))
    const result = replay(changed)
    expect(result).toMatchObject({ ok: false, reason: "diverged" })
    expect(
      result.ok === false && result.reason === "diverged" && result.step,
    ).toBeGreaterThanOrEqual(3)
    expect(replay(rewrite(recording, 2, (step) => ({ ...step, outputs: [] })))).toMatchObject({
      ok: false,
      reason: "diverged",
      step: 2,
      expected: expect.stringMatching(/^\{"outputs":\[\],"next":/),
    })
  })

  it("notices draws that are missing or left over", () => {
    const recording = recordRegistration(2, 0).recording()
    const steps = recording.split("\n")
    const index = steps.findIndex(
      (line, at) => at > 0 && (decode(line) as { random: number[] }).random.length > 0,
    )
    const fewer = rewrite(recording, index, (step) => ({ ...step, random: [] }))
    expect(replay(fewer)).toMatchObject({ ok: false, reason: "diverged", step: index })
    const more = rewrite(recording, index, (step) => ({
      ...step,
      random: [...(step["random"] as number[]), 0.5],
    }))
    expect(replay(more)).toMatchObject({ ok: false, reason: "diverged", step: index })
    const none = rewrite(recording, 0, (head) => ({ ...head, random: [] }))
    expect(replay(none)).toMatchObject({
      ok: false,
      reason: "diverged",
      step: 0,
      actual: '{"thrown":"Error: The recording has no random draw left here","next":null}',
    })
    const extra = rewrite(recording, 0, (head) => ({
      ...head,
      random: [...(head["random"] as number[]), 0.5],
    }))
    expect(replay(extra)).toMatchObject({
      ok: false,
      reason: "diverged",
      step: 0,
      actual: expect.stringMatching(/^\{"outputs":\[\],"next":/),
    })
  })

  it("refuses recordings it cannot replay", () => {
    const recording = recordRegistration(3, 0).recording()
    expect(replay("")).toStrictEqual({ ok: false, reason: "invalid" })
    expect(replay("not json\n")).toStrictEqual({ ok: false, reason: "invalid" })
    expect(replay(rewrite(recording, 0, (head) => ({ ...head, straw: "other" })))).toStrictEqual({
      ok: false,
      reason: "invalid",
    })
    expect(replay(rewrite(recording, 0, (head) => ({ ...head, version: 2 })))).toStrictEqual({
      ok: false,
      reason: "invalid",
    })
    expect(replay(rewrite(recording, 0, (head) => ({ ...head, release: 1 })))).toStrictEqual({
      ok: false,
      reason: "invalid",
    })
    expect(replay(rewrite(recording, 0, (head) => ({ ...head, release: "9.9.9" })))).toStrictEqual({
      ok: false,
      reason: "version",
      version: "9.9.9",
    })
    expect(replay(rewrite(recording, 0, (head) => ({ ...head, truncated: true })))).toStrictEqual({
      ok: false,
      reason: "truncated",
    })
  })

  it("replays what a Node driver feeds it as Buffers", () => {
    const core = createRecordedCore({
      address: alice,
      aor: "sip:alice@example.com",
      random: createRandom(9),
    })
    core.handle({ type: "receive", data: Buffer.from(incomingOptions()), from: bob }, 0)
    expect(replay(core.recording())).toStrictEqual({ ok: true, steps: 1 })
  })

  it("replays a step that drew before it threw, and notices a different error", () => {
    const core = createRecordedCore({
      address: alice,
      aor: "sip:alice@example.com",
      random: () => 0.5,
    })
    const same = {
      type: "command",
      command: { type: "options", uri: "sip:bob@example.com", to: bob, callId: "c1" },
    } as const
    core.handle(same, 0)
    expect(() => core.handle(same, 1)).toThrow()
    const recording = core.recording()
    expect(replay(recording)).toStrictEqual({ ok: true, steps: 2 })
    const lines = recording.split("\n")
    expect((decode(lines[2] ?? "") as { random: number[] }).random.length).toBeGreaterThan(0)
    expect(
      replay(rewrite(recording, 2, (step) => ({ ...step, thrown: "Error: something else" }))),
    ).toMatchObject({
      ok: false,
      step: 2,
    })
  })

  it("notices a changed event, a changed last output and a changed deadline", () => {
    const core = createRecordedCore({
      address: alice,
      aor: "sip:alice@example.com",
      random: createRandom(4),
    })
    core.handle({ type: "receive", data: incomingOptions(), from: bob }, 0)
    core.handle({ type: "receive", data: new Uint8Array([0xff]), from: bob }, 0.9)
    core.handle(
      { type: "command", command: { type: "options", uri: "sip:bob@example.com", to: bob } },
      1.5,
    )
    core.handle({ type: "timeout" }, 501.5)
    const recording = core.recording()
    expect(replay(recording)).toStrictEqual({ ok: true, steps: 4 })
    const okText = (step: Record<string, unknown>) =>
      JSON.parse(encode(step).replace("200 OK", "200 Ok"))
    expect(
      replay(rewrite(recording, 1, (step) => decode(JSON.stringify(okText(step))))),
    ).toMatchObject({ ok: false, step: 1 })
    const invalid = (step: Record<string, unknown>) =>
      decode(encode(step).replace(/"error":"[^"]*"/, '"error":"something else"'))
    expect(replay(rewrite(recording, 2, invalid))).toMatchObject({ ok: false, step: 2 })
    expect(replay(rewrite(recording, 3, (step) => ({ ...step, next: 1 })))).toMatchObject({
      ok: false,
      step: 3,
    })
    expect(replay(rewrite(recording, 0, (head) => ({ ...head, next: 5 })))).toMatchObject({
      ok: false,
      step: 0,
    })
    expect(replay(rewrite(recording, 4, (step) => ({ ...step, now: 501 })))).toMatchObject({
      ok: false,
      step: 4,
    })
  })

  it("replays a step with a time that is not a number", () => {
    const core = createRecordedCore({
      address: alice,
      aor: "sip:alice@example.com",
      random: createRandom(4),
    })
    expect(() => core.handle({ type: "timeout" }, Number.NaN)).toThrow("Invalid time")
    expect(replay(core.recording())).toStrictEqual({ ok: true, steps: 1 })
  })

  it("replays masked secrets in what came in and keeps bodies as they were", () => {
    const core = createRecordedCore({
      address: alice,
      aor: "sip:alice@example.com",
      random: createRandom(6),
    })
    const message = [
      "MESSAGE sip:alice@example.com SIP/2.0",
      "Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bK2",
      'From: <sip:bob@example.com>;tag=b1;response="x1"',
      "To: <sip:alice@example.com>",
      "Call-ID: m1",
      "CSeq: 1 MESSAGE",
      'Authorization: Digest username="bob", response="6629fae49393a05397450978507c4ef1"',
      "Content-Length: 41",
      "",
      'response="6629fae49393a05397450978507c4e"',
    ].join("\r\n")
    core.handle({ type: "receive", data: bytes(message), from: bob }, 0)
    const recording = core.recording()
    expect(recording).not.toContain("6629fae49393a05397450978507c4ef1")
    expect(recording).toContain('response=\\"6629fae49393a05397450978507c4e\\"')
    expect(replay(recording)).toStrictEqual({ ok: true, steps: 1 })
  })

  it("calls recordings with the wrong shape invalid instead of throwing", () => {
    const recording = recordRegistration(4, 0).recording()
    const [head = "", step = ""] = recording.split("\n")
    expect(replay(`${head}\nnull\n`)).toStrictEqual({ ok: false, reason: "invalid" })
    const noDraws = JSON.parse(step)
    delete noDraws.random
    expect(replay(`${head}\n${JSON.stringify(noDraws)}\n`)).toStrictEqual({
      ok: false,
      reason: "invalid",
    })
    const neither = JSON.parse(step)
    delete neither.outputs
    expect(replay(`${head}\n${JSON.stringify(neither)}\n`)).toStrictEqual({
      ok: false,
      reason: "invalid",
    })
    for (const key of ["random", "options", "next", "truncated"]) {
      const header = JSON.parse(head)
      delete header[key]
      expect(replay(`${JSON.stringify(header)}\n`), key).toStrictEqual({
        ok: false,
        reason: "invalid",
      })
    }
    expect(
      replay(
        `${head}\n{"now":1,"input":{"type":"timeout"},"random":["x"],"next":null,"outputs":[]}\n`,
      ),
    ).toStrictEqual({ ok: false, reason: "invalid" })
    expect(
      replay(`${head}\n{"now":1,"input":{"type":"timeout"},"random":[],"next":"x","outputs":[]}\n`),
    ).toStrictEqual({ ok: false, reason: "invalid" })
    expect(
      replay(
        `${head}\n{"now":"1","input":{"type":"timeout"},"random":[],"next":null,"outputs":[]}\n`,
      ),
    ).toStrictEqual({ ok: false, reason: "invalid" })
    expect(
      replay(`${head}\n{"now":1,"input":null,"random":[],"next":null,"outputs":[]}\n`),
    ).toStrictEqual({ ok: false, reason: "invalid" })
    expect(replay("[1]\n")).toStrictEqual({ ok: false, reason: "invalid" })
  })
})

function incomingOptions(): Uint8Array {
  return bytes(
    [
      "OPTIONS sip:alice@example.com SIP/2.0",
      "Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bK1",
      "From: <sip:bob@example.com>;tag=b1",
      "To: <sip:alice@example.com>",
      "Call-ID: c1",
      "CSeq: 1 OPTIONS",
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n"),
  )
}
