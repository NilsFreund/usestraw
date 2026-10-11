import { describe, expect, it } from "vitest"
import type { CallMedia, MediaAddress } from "../../src"
import { createMediaEngine, type MediaEngine } from "../../src/rtp/engine"
import { decodeG711, encodeG711 } from "../../src/rtp/g711"
import { writeRtp } from "../../src/rtp/packet"
import { between, chance, createRandom } from "../../src/simulation/random"

const left: MediaAddress = { host: "192.0.2.10", port: 40_000 }
const right: MediaAddress = { host: "192.0.2.20", port: 4000 }
const towards = (remote: MediaAddress): CallMedia => ({
  remote,
  codec: "PCMA",
  payloadType: 8,
  ptime: 20,
  direction: "sendrecv",
})

interface Flight {
  readonly at: number
  readonly data: Uint8Array
  readonly from: MediaAddress
  readonly to: MediaEngine
}

// Two media engines over a network that delays (20 to 60 ms), reorders and loses packets, in virtual time
function talk(seed: number, loss: number, seconds: number) {
  const random = createRandom(seed)
  const a = createMediaEngine(createRandom(seed + 1))
  const b = createMediaEngine(createRandom(seed + 2))
  a.handle({ type: "media", media: towards(right) }, 0)
  b.handle({ type: "media", media: towards(left) }, 0)
  const tone = Int16Array.from({ length: 8000 * seconds }, (_, index) =>
    Math.round(10_000 * Math.sin((2 * Math.PI * 300 * index) / 8000)),
  )
  a.handle({ type: "audio", pcm: tone }, 0)
  const heard: Int16Array[] = []
  let flights: Flight[] = []
  let sent = 0
  for (let now = 0; now <= seconds * 1000 + 500; now++) {
    const due = flights.filter((flight) => flight.at <= now)
    flights = flights.filter((flight) => flight.at > now)
    for (const flight of due)
      flight.to.handle({ type: "packet", data: flight.data, from: flight.from }, now)
    for (const [engine, from, to] of [
      [a, left, b],
      [b, right, a],
    ] as const) {
      if ((engine.nextDeadline() ?? Number.POSITIVE_INFINITY) > now) continue
      for (const output of engine.handle({ type: "timeout" }, now)) {
        if (output.type === "frame") {
          if (engine === b) heard.push(output.pcm)
          continue
        }
        if (output.type !== "send") continue
        if (engine === a) sent++
        if (chance(random, loss)) continue
        flights.push({ at: now + between(random, 20, 60), data: output.data, from, to })
      }
    }
  }
  return { heard, sent }
}

describe("audio between two media engines", () => {
  it("arrives complete and in order over a clean but jittery network", () => {
    const { heard, sent } = talk(1, 0, 2)
    expect(sent).toBeGreaterThanOrEqual(100)
    expect(heard.every((pcm) => pcm.length === 160)).toBe(true)
    const all = Int16Array.from(heard.flatMap((pcm) => [...pcm]))
    const tone = Int16Array.from({ length: 16_000 }, (_, index) =>
      Math.round(10_000 * Math.sin((2 * Math.PI * 300 * index) / 8000)),
    )
    const expected = decodeG711("PCMA", encodeG711("PCMA", tone))
    const start = all.findIndex((_, at) =>
      expected.slice(0, 160).every((value, index) => all[at + index] === value),
    )
    expect(start).toBeGreaterThan(0)
    expect(all.slice(start, start + expected.length)).toStrictEqual(expected)
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("conceals 10 %% loss with silence in seed %i", (seed) => {
    const { heard } = talk(seed, 0.1, 3)
    const silent = heard.filter((pcm) => pcm.every((value) => value === 0)).length
    expect(silent / heard.length).toBeGreaterThan(0.02)
    expect(silent / heard.length).toBeLessThan(0.25)
    expect(heard.reduce((sum, pcm) => sum + pcm.length, 0)).toBeGreaterThan(20_000)
  })
})

describe("media engines under hostile and drifting input", () => {
  it("never throws and always plays 160 samples, whatever packets arrive", () => {
    const random = createRandom(3550)
    const engine = createMediaEngine(createRandom(1))
    engine.handle({ type: "media", media: towards(right) }, 0)
    const sources = [
      right,
      { ...right, port: 4002 },
      { host: "203.0.113.9", port: 9 },
      { ...right, port: 0 },
    ]
    let played = 0
    for (let now = 0; now < 20_000; now += between(random, 0, 7)) {
      const size = [0, 1, 80, 160, 161, 320, 960, 961, 2000][between(random, 0, 8)] ?? 160
      const payload = Uint8Array.from({ length: size }, () => between(random, 0, 255))
      const packet = writeRtp({
        marker: chance(random, 0.1),
        payloadType: [0, 8, 13, 101, 127][between(random, 0, 4)] ?? 0,
        sequence: between(random, 0, 65_535),
        timestamp: chance(random, 0.5)
          ? between(random, 0, 4000) * 80
          : between(random, 0, 2 ** 32 - 1),
        ssrc: between(random, 1, 3),
        payload,
      })
      const data = chance(random, 0.05)
        ? packet.slice(0, between(random, 0, packet.length))
        : packet
      const from = sources[between(random, 0, sources.length - 1)] ?? right
      engine.handle({ type: "packet", data, from }, now)
      for (const output of engine.handle({ type: "timeout" }, now)) {
        if (output.type !== "frame") continue
        expect(output.pcm).toHaveLength(160)
        played++
      }
    }
    expect(played).toBeGreaterThan(900)
  })

  it.each([
    ["a slow sender clock", 1.002],
    ["a fast sender clock", 0.998],
  ])("keeps playing with %s and keeps its delay bounded", (_, stretch) => {
    const sender = createMediaEngine(createRandom(5))
    const receiver = createMediaEngine(createRandom(6))
    sender.handle({ type: "media", media: towards(right) }, 0)
    receiver.handle({ type: "media", media: towards(left) }, 0)
    const tone = Int16Array.from({ length: 8000 * 120 }, (_, index) =>
      index % 160 < 80 ? 8000 : -8000,
    )
    sender.handle({ type: "audio", pcm: tone }, 0)
    let silent = 0
    let frames = 0
    for (let now = 0; now <= 120_000; now++) {
      for (const output of sender.handle({ type: "timeout" }, now)) {
        if (output.type === "send")
          receiver.handle({ type: "packet", data: output.data, from: right }, now * stretch + 30)
      }
      for (const output of receiver.handle({ type: "timeout" }, now * stretch + 30)) {
        if (output.type !== "frame") continue
        frames++
        if (output.pcm.every((value) => value === 0)) silent++
      }
    }
    expect(frames).toBeGreaterThan(5900)
    expect(silent / frames).toBeLessThan(0.05)
  })

  it("is back to a short delay after the receiver stalls for half a second", () => {
    const sender = createMediaEngine(createRandom(7))
    const receiver = createMediaEngine(createRandom(8))
    sender.handle({ type: "media", media: towards(right) }, 0)
    receiver.handle({ type: "media", media: towards(left) }, 0)
    const marks = Array.from(
      { length: 128 },
      (_, code) => decodeG711("PCMA", Uint8Array.of(code))[0] ?? 0,
    )
    const marked = Int16Array.from(
      { length: 8000 * 4 },
      (_, index) => marks[Math.floor(index / 160) % 128] ?? 0,
    )
    sender.handle({ type: "audio", pcm: marked }, 0)
    const backlog: Uint8Array[] = []
    let last = 0
    for (let now = 0; now <= 3000; now++) {
      for (const output of sender.handle({ type: "timeout" }, now)) {
        if (output.type === "send") backlog.push(output.data)
      }
      if (now >= 1000 && now < 1500) continue
      for (const data of backlog.splice(0))
        receiver.handle({ type: "packet", data, from: right }, now)
      for (const output of receiver.handle({ type: "timeout" }, now)) {
        if (output.type === "frame" && now === 3000) last = output.pcm[0] ?? 0
      }
    }
    const sending = 3000 / 20
    const playing = marks.indexOf(last)
    const delay = (((sending - playing) % 128) + 128) % 128
    expect(playing).toBeGreaterThanOrEqual(0)
    expect(delay).toBeGreaterThanOrEqual(1)
    expect(delay).toBeLessThanOrEqual(6)
  })
})
