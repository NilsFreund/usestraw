import { describe, expect, it } from "vitest"
import type { CallMedia, MediaAddress } from "../../src"
import { createMediaEngine, type MediaEngine, type MediaOutput } from "../../src/rtp/engine"
import { decodeG711, encodeG711 } from "../../src/rtp/g711"
import { readRtp, writeRtp } from "../../src/rtp/packet"

const remote = { host: "192.0.2.20", port: 4000 }
const media: CallMedia = { remote, codec: "PCMU", payloadType: 0, ptime: 20, direction: "sendrecv" }
const nat = { host: "198.51.100.7", port: 31_000 }
const stranger = { host: "203.0.113.66", port: 666 }

const sent = (outputs: MediaOutput[]) =>
  outputs.flatMap((output) =>
    output.type === "send" ? [{ to: output.to, packet: readRtp(output.data) }] : [],
  )
const frames = (outputs: MediaOutput[]) =>
  outputs.flatMap((output) => (output.type === "frame" ? [output.pcm] : []))
const level = (pcm: Int16Array | undefined) => Math.sign(pcm?.[0] ?? 0)

interface Options {
  readonly payloadType?: number
  readonly ssrc?: number
  readonly value?: number
  readonly samples?: number
}

function rtp(index: number, options: Options = {}) {
  const { payloadType = 0, ssrc = 9, value = 1000, samples = 160 } = options
  const payload = encodeG711("PCMU", new Int16Array(samples).fill(value))
  return writeRtp({
    marker: false,
    payloadType,
    sequence: index,
    timestamp: index * 160,
    ssrc,
    payload,
  })
}

function live(overrides: Partial<CallMedia> = {}, random = () => 0.5) {
  const engine = createMediaEngine(random)
  engine.handle({ type: "media", media: { ...media, ...overrides } }, 0)
  return engine
}

function hear(
  engine: MediaEngine,
  from: MediaAddress,
  indexes: number[],
  at: number,
  options?: Options,
) {
  for (const index of indexes)
    engine.handle({ type: "packet", data: rtp(index, options), from }, at)
}

describe("media engine: sending", () => {
  it("does nothing before it knows the media", () => {
    const engine = createMediaEngine(() => 0.5)
    expect(engine.nextDeadline()).toBeUndefined()
    expect(engine.handle({ type: "timeout" }, 100)).toStrictEqual([])
    expect(engine.handle({ type: "packet", data: rtp(0), from: remote }, 100)).toStrictEqual([])
  })

  it("sends a packet every ptime with silence when the app says nothing", () => {
    const engine = live()
    expect(engine.nextDeadline()).toBe(0)
    const [first] = sent(engine.handle({ type: "timeout" }, 0))
    expect(first).toStrictEqual({
      to: remote,
      packet: {
        marker: true,
        payloadType: 0,
        sequence: 32_768,
        timestamp: 2 ** 31,
        ssrc: 2 ** 31,
        payload: new Uint8Array(160).fill(0xff),
      },
    })
    const [second] = sent(engine.handle({ type: "timeout" }, 20))
    expect(second?.packet).toMatchObject({
      marker: false,
      sequence: 32_769,
      timestamp: 2 ** 31 + 160,
    })
  })

  it("wraps the sequence number and the timestamp", () => {
    const engine = live({}, () => 0.999_999_99)
    const packets = sent([
      ...engine.handle({ type: "timeout" }, 0),
      ...engine.handle({ type: "timeout" }, 20),
    ])
    expect(packets.map((entry) => entry.packet?.sequence)).toStrictEqual([65_535, 0])
    expect(packets.map((entry) => entry.packet?.timestamp)).toStrictEqual([2 ** 32 - 43, 117])
  })

  it("cuts queued audio into packets, pads the last one with silence and takes any size", () => {
    const engine = live({ codec: "PCMA", payloadType: 8 })
    engine.handle({ type: "audio", pcm: new Int16Array(200).fill(4000) }, 0)
    engine.handle({ type: "audio", pcm: new Int16Array(200).fill(-4000) }, 0)
    engine.handle({ type: "audio", pcm: new Int16Array() }, 0)
    expect(engine.queued).toBe(400)
    const packets = sent(engine.handle({ type: "timeout" }, 40)).map((entry) => entry.packet)
    const pcm = packets.flatMap((packet) => [
      ...decodeG711("PCMA", packet?.payload ?? new Uint8Array()),
    ])
    expect(pcm.slice(0, 200).every((value) => value > 3000)).toBe(true)
    expect(pcm.slice(200, 400).every((value) => value < -3000)).toBe(true)
    expect(pcm.slice(400).every((value) => Math.abs(value) <= 8)).toBe(true)
    engine.handle({ type: "audio", pcm: new Int16Array(8000 * 11) }, 50)
    expect(engine.queued).toBe(88_000)
  })

  it("throws away what it was about to say on clear (barge-in)", () => {
    const engine = live()
    engine.handle({ type: "audio", pcm: new Int16Array(800).fill(4000) }, 0)
    engine.handle({ type: "clear" }, 0)
    expect(engine.queued).toBe(0)
    const [packet] = sent(engine.handle({ type: "timeout" }, 0))
    expect(packet?.packet?.payload).toStrictEqual(new Uint8Array(160).fill(0xff))
  })

  it("catches up a few late packets and starts over when it fell far behind, timestamp and marker following the clock", () => {
    const engine = live()
    engine.handle({ type: "timeout" }, 0)
    const late = sent(engine.handle({ type: "timeout" }, 60))
    expect(late.map((entry) => entry.packet?.marker)).toStrictEqual([false, false, false])
    const [after] = sent(engine.handle({ type: "timeout" }, 1000))
    expect(after?.packet).toMatchObject({ marker: true, timestamp: 2 ** 31 + 8000 })
    expect(engine.nextDeadline()).toBe(1020)
  })

  it("catches up exactly five late packets and starts over after more", () => {
    const engine = live()
    engine.handle({ type: "timeout" }, 0)
    expect(sent(engine.handle({ type: "timeout" }, 120))).toHaveLength(6)
    const fresh = live()
    fresh.handle({ type: "timeout" }, 0)
    expect(sent(fresh.handle({ type: "timeout" }, 121))).toHaveLength(1)
  })

  it("keeps its clocks when the same media is announced again", () => {
    const engine = live()
    engine.handle({ type: "timeout" }, 0)
    engine.handle({ type: "media", media }, 5)
    expect(engine.nextDeadline()).toBe(20)
    const listening = live({ direction: "recvonly" })
    listening.handle({ type: "timeout" }, 0)
    listening.handle({ type: "media", media: { ...media, direction: "recvonly" } }, 5)
    expect(listening.nextDeadline()).toBe(20)
  })

  it.each([
    [30, 30, 240],
    [10, 10, 80],
    [5, 10, 80],
    [0, 10, 80],
  ])("sends at a ptime of %i ms every %i ms with %i samples", (ptime, every, samples) => {
    const engine = live({ ptime, direction: "sendonly" })
    const [first] = sent(engine.handle({ type: "timeout" }, 0))
    expect(first?.packet?.payload).toHaveLength(samples)
    expect(sent(engine.handle({ type: "timeout" }, every))).toHaveLength(1)
  })

  it.each(["recvonly", "inactive"] as const)("sends nothing while the call is %s", (direction) => {
    const engine = live({ direction })
    expect(sent(engine.handle({ type: "timeout" }, 100))).toStrictEqual([])
  })

  it("lets the timestamp run on through hold and marks the first packet after it", () => {
    const engine = live()
    engine.handle({ type: "timeout" }, 0)
    engine.handle({ type: "media", media: { ...media, direction: "recvonly" } }, 10)
    expect(sent(engine.handle({ type: "timeout" }, 400))).toStrictEqual([])
    engine.handle({ type: "media", media }, 500)
    const [resumed] = sent(engine.handle({ type: "timeout" }, 500))
    expect(resumed?.packet).toMatchObject({
      marker: true,
      sequence: 32_769,
      timestamp: 2 ** 31 + 4000,
    })
  })
})

describe("media engine: hearing", () => {
  it("plays a steady 20 ms frame once the media is known, silence included", () => {
    const engine = live({ direction: "recvonly" })
    const quiet = frames(engine.handle({ type: "timeout" }, 40))
    expect(quiet.map((pcm) => pcm.length)).toStrictEqual([160, 160, 160])
    expect(quiet.every((pcm) => pcm.every((value) => value === 0))).toBe(true)
    hear(engine, remote, [0, 1, 2], 50)
    const played = frames(engine.handle({ type: "timeout" }, 120)).map(level)
    expect(played).toStrictEqual([1, 1, 1, 0])
  })

  it("decodes by payload type: PCMA, and a dynamic number for the agreed codec", () => {
    const engine = live({ direction: "recvonly", payloadType: 96 })
    const alaw = writeRtp({
      marker: false,
      payloadType: 8,
      sequence: 0,
      timestamp: 0,
      ssrc: 9,
      payload: encodeG711("PCMA", new Int16Array(160).fill(-2000)),
    })
    engine.handle({ type: "packet", data: alaw, from: remote }, 0)
    hear(engine, remote, [1, 2], 0, { payloadType: 96 })
    expect(frames(engine.handle({ type: "timeout" }, 60)).map(level)).toStrictEqual([-1, 1, 1, 0])
  })

  it("plays one frame and not a flood after it stalled", () => {
    const engine = live({ direction: "recvonly" })
    engine.handle({ type: "timeout" }, 0)
    expect(frames(engine.handle({ type: "timeout" }, 1000))).toHaveLength(1)
  })

  it("does not let an empty packet claim the stream", () => {
    const engine = live({ direction: "recvonly" })
    hear(engine, remote, [0], 0, { samples: 0, ssrc: 5 })
    hear(engine, remote, [1, 2, 3], 10)
    expect(frames(engine.handle({ type: "timeout" }, 80)).map(level)).toContain(1)
  })

  it("ignores tones, unknown payload types, empty or oversized payloads and port 0", () => {
    const engine = live({ direction: "recvonly", dtmf: 101 })
    hear(engine, remote, [0], 0, { payloadType: 101 })
    hear(engine, remote, [1], 0, { payloadType: 18 })
    hear(engine, remote, [2], 0, { samples: 0 })
    hear(engine, remote, [3], 0, { samples: 961 })
    hear(engine, { ...remote, port: 0 }, [4, 5, 6, 7], 0)
    engine.handle({ type: "packet", data: Uint8Array.of(1, 2, 3), from: remote }, 0)
    expect(
      frames(engine.handle({ type: "timeout" }, 200))
        .map(level)
        .every((value) => value === 0),
    ).toBe(true)
  })
})

describe("media engine: who it listens to (symmetric RTP without RTP Bleed)", () => {
  const destination = (engine: MediaEngine, at: number) =>
    sent(engine.handle({ type: "timeout" }, at))[0]?.to

  it("learns a peer behind NAT after three packets in sequence and answers there", () => {
    const engine = live()
    hear(engine, nat, [0, 1], 0)
    expect(destination(engine, 0)).toStrictEqual(remote)
    hear(engine, nat, [2], 40)
    expect(destination(engine, 40)).toStrictEqual(nat)
    expect(frames(engine.handle({ type: "timeout" }, 120)).map(level)).toContain(1)
  })

  it("follows a new port of the signalled host at once", () => {
    const engine = live()
    hear(engine, { ...remote, port: 4002 }, [0], 0)
    expect(destination(engine, 0)).toStrictEqual({ ...remote, port: 4002 })
  })

  it.each([
    [
      "a gap in the sequence",
      [
        [nat, 0, 9],
        [nat, 1, 9],
        [nat, 3, 9],
      ],
    ],
    [
      "another SSRC",
      [
        [nat, 0, 9],
        [nat, 1, 9],
        [nat, 2, 1],
      ],
    ],
    [
      "another source",
      [
        [nat, 0, 9],
        [nat, 1, 9],
        [stranger, 2, 9],
      ],
    ],
  ] as const)("does not learn from three packets with %s", (_, packets) => {
    const engine = live()
    for (const [from, index, ssrc] of packets) hear(engine, from, [index], 0, { ssrc })
    expect(destination(engine, 0)).toStrictEqual(remote)
  })

  it("never lets a stranger take over once the signalled address speaks", () => {
    const engine = live()
    hear(engine, remote, [0], 0)
    hear(engine, stranger, [1, 2, 3, 4], 10, { value: -1000 })
    expect(destination(engine, 20)).toStrictEqual(remote)
    expect(frames(engine.handle({ type: "timeout" }, 200)).map(level)).not.toContain(-1)
  })

  it("stops learning two seconds after the media is known and after it learnt once", () => {
    const engine = live()
    hear(engine, nat, [0, 1, 2], 2001)
    expect(destination(engine, 2001)).toStrictEqual(remote)
    const edge = live()
    hear(edge, nat, [0, 1, 2], 2000)
    expect(destination(edge, 2000)).toStrictEqual(nat)
    const early = live()
    hear(early, nat, [0, 1, 2], 0)
    hear(early, stranger, [3, 4, 5], 20)
    expect(destination(early, 40)).toStrictEqual(nat)
  })

  it("forgets what it learnt, and a half-learnt source, when the media moves", () => {
    const engine = live()
    hear(engine, nat, [0, 1, 2], 0)
    const moved = { ...media, remote: { host: "192.0.2.30", port: 5000 } }
    engine.handle({ type: "media", media: moved }, 10)
    expect(destination(engine, 20)).toStrictEqual(moved.remote)
    const half = live()
    hear(half, nat, [0, 1], 0)
    half.handle({ type: "media", media: moved }, 10)
    hear(half, nat, [2], 20)
    expect(destination(half, 20)).toStrictEqual(moved.remote)
  })

  it("goes back to the signalled address when it speaks after a latch", () => {
    const engine = live()
    hear(engine, nat, [0, 1, 2], 0)
    hear(engine, remote, [3], 20)
    expect(destination(engine, 20)).toStrictEqual(remote)
  })

  it("learns again when the media moves, and compares IPv6 hosts by value", () => {
    const engine = live({ remote: { host: "2001:DB8:0:0::5", port: 4000 } })
    hear(engine, { host: "2001:db8::5", port: 4000 }, [0], 0)
    expect(destination(engine, 0)).toStrictEqual({ host: "2001:DB8:0:0::5", port: 4000 })
    const moved = { ...media, remote: { host: "192.0.2.30", port: 5000 } }
    engine.handle({ type: "media", media: moved }, 5000)
    hear(engine, nat, [10, 11, 12], 5000)
    expect(destination(engine, 5000)).toStrictEqual(nat)
  })
})

describe("media engine: silence", () => {
  const silent = (outputs: MediaOutput[]) => outputs.filter((output) => output.type === "silent")

  it("reports once when the far end sent nothing for a minute", () => {
    const engine = live()
    expect(silent(engine.handle({ type: "timeout" }, 59_999))).toHaveLength(0)
    expect(silent(engine.handle({ type: "timeout" }, 60_000))).toHaveLength(1)
    expect(silent(engine.handle({ type: "timeout" }, 120_000))).toHaveLength(0)
  })

  it("counts tones, comfort noise and a learnt source as signs of life, but not strangers", () => {
    const early = live()
    hear(early, stranger, [1], 1500)
    expect(silent(early.handle({ type: "timeout" }, 60_000))).toHaveLength(1)
    const engine = live()
    hear(engine, remote, [1], 30_000, { payloadType: 13 })
    hear(engine, stranger, [2, 3, 4, 5], 50_000)
    expect(silent(engine.handle({ type: "timeout" }, 89_999))).toHaveLength(0)
    expect(silent(engine.handle({ type: "timeout" }, 90_000))).toHaveLength(1)
    const natted = live({ remote: { host: "10.0.0.5", port: 4000 } })
    hear(natted, nat, [1, 2, 3], 1000)
    hear(natted, nat, [4], 40_000)
    expect(silent(natted.handle({ type: "timeout" }, 99_999))).toHaveLength(0)
    expect(silent(natted.handle({ type: "timeout" }, 100_000))).toHaveLength(1)
  })

  it.each(["recvonly", "inactive"] as const)("waits nobody out who holds us (%s)", (direction) => {
    const held = live({ direction })
    expect(silent(held.handle({ type: "timeout" }, 600_000))).toHaveLength(0)
  })

  it("waits nobody out on hold, and starts over when the media changes", () => {
    const held = live({ direction: "sendonly" })
    hear(held, remote, [1], 1000)
    expect(silent(held.handle({ type: "timeout" }, 600_000))).toHaveLength(0)
    held.handle({ type: "media", media }, 600_000)
    expect(silent(held.handle({ type: "timeout" }, 659_999))).toHaveLength(0)
    expect(silent(held.handle({ type: "timeout" }, 660_000))).toHaveLength(1)
  })
})
