import { describe, expect, it } from "vitest"
import { createJitter, type Heard } from "../../src/rtp/jitter"

const heard = (index: number, options: Partial<Heard> = {}): Heard => ({
  ssrc: 7,
  sequence: index,
  timestamp: 1000 + index * 160,
  pcm: new Int16Array(160).fill(index + 1),
  ...options,
})

type Jitter = ReturnType<typeof createJitter>

const label = (frame: Int16Array) => {
  const values = [...new Set(frame)]
  return values.length === 1 ? (values[0] ?? 0) : values
}

function play(jitter: Jitter, from: number, frames: number): unknown[] {
  return Array.from({ length: frames }, (_, index) => label(jitter.read(160, from + index * 20)))
}

describe("jitter buffer", () => {
  it("plays silence until it holds 60 ms, then one packet per frame", () => {
    const jitter = createJitter()
    expect(label(jitter.read(160, 0))).toBe(0)
    jitter.push(heard(0), 0)
    jitter.push(heard(1), 20)
    expect(label(jitter.read(160, 20))).toBe(0)
    jitter.push(heard(2), 40)
    expect(play(jitter, 40, 4)).toStrictEqual([1, 2, 3, 0])
  })

  it("starts playing 60 ms after the first packet even with less buffered", () => {
    const jitter = createJitter()
    jitter.push(heard(0, { pcm: new Int16Array(80).fill(1) }), 0)
    jitter.push(heard(1, { timestamp: 1080, pcm: new Int16Array(80).fill(1) }), 30)
    expect(label(jitter.read(160, 59))).toBe(0)
    expect(label(jitter.read(160, 60))).toBe(1)
  })

  it("puts reordered packets back in order and ignores copies", () => {
    const jitter = createJitter()
    jitter.push(heard(0), 0)
    jitter.push(heard(2), 5)
    jitter.push(heard(1), 10)
    jitter.push(heard(1, { pcm: new Int16Array(160).fill(99) }), 11)
    expect(play(jitter, 100, 3)).toStrictEqual([1, 2, 3])
  })

  it("conceals a lost packet with silence of the same length", () => {
    const jitter = createJitter()
    for (const index of [0, 2, 3]) jitter.push(heard(index), 0)
    expect(play(jitter, 100, 4)).toStrictEqual([1, 0, 3, 4])
  })

  it("cuts frames from packets of any size", () => {
    const jitter = createJitter()
    jitter.push({ ...heard(0), pcm: new Int16Array(80).fill(1) }, 0)
    jitter.push({ ...heard(1), timestamp: 1080, pcm: new Int16Array(480).fill(2) }, 0)
    expect(play(jitter, 100, 5)).toStrictEqual([[1, 2], 2, 2, [2, 0], 0])
  })

  it("does not trip over packets that overlap what it already played", () => {
    const jitter = createJitter()
    jitter.push({ ...heard(0), pcm: new Int16Array(320).fill(1) }, 0)
    jitter.push(heard(1), 0)
    jitter.push(heard(2, { timestamp: 1000 + 160 + 80 }), 0)
    jitter.push(heard(3), 0)
    expect(play(jitter, 100, 5)).toStrictEqual([1, 1, [3, 0], 4, 0])
  })

  it("drops what comes after its turn and refills after running dry", () => {
    const jitter = createJitter()
    for (const index of [0, 1, 2]) jitter.push(heard(index), 0)
    expect(play(jitter, 100, 4)).toStrictEqual([1, 2, 3, 0])
    jitter.push(heard(1), 200)
    jitter.push(heard(3), 200)
    expect(label(jitter.read(160, 220))).toBe(0)
    expect(label(jitter.read(160, 260))).toBe(4)
  })

  it("jumps over a long pause instead of filling it with silence", () => {
    const jitter = createJitter()
    jitter.push(heard(0), 0)
    jitter.read(160, 60)
    for (const index of [50, 51, 52]) jitter.push(heard(index), 1000 + (index - 50) * 20)
    expect(play(jitter, 1040, 3)).toStrictEqual([51, 52, 53])
  })

  it("jumps over a gap of more than 100 ms between what it holds", () => {
    const jitter = createJitter()
    jitter.push(heard(0), 0)
    jitter.read(160, 60)
    for (const index of [9, 10]) jitter.push(heard(index), 200)
    expect(play(jitter, 200, 3)).toStrictEqual([10, 11, 0])
  })

  it("trims itself back to 60 ms when it holds more than 200 ms", () => {
    const jitter = createJitter()
    for (let index = 0; index < 20; index++) jitter.push(heard(index), 0)
    expect(play(jitter, 100, 2)).toStrictEqual([18, 19])
  })

  it("keeps one source while it talks and takes another once it went quiet", () => {
    const jitter = createJitter()
    for (const index of [0, 1, 2]) jitter.push(heard(index), index * 20)
    jitter.push(heard(3, { ssrc: 8, timestamp: 9 }), 60)
    expect(play(jitter, 60, 3)).toStrictEqual([1, 2, 3])
    for (const index of [10, 11, 12])
      jitter.push(heard(index, { ssrc: 8, timestamp: index * 160 }), 300)
    expect(play(jitter, 300, 3)).toStrictEqual([11, 12, 13])
  })

  it("keeps up to 200 ms and trims beyond", () => {
    const kept = createJitter()
    for (let index = 0; index < 10; index++) kept.push(heard(index), 0)
    expect(label(kept.read(160, 100))).toBe(1)
    const trimmed = createJitter()
    for (let index = 0; index < 11; index++) trimmed.push(heard(index), 0)
    expect(label(trimmed.read(160, 100))).toBe(9)
  })

  it("starts over when the timestamps jump back by more than two seconds", () => {
    const jitter = createJitter()
    for (const index of [200, 201, 202]) jitter.push(heard(index), 0)
    for (const index of [50, 51, 52]) jitter.push(heard(index), 20)
    expect(play(jitter, 100, 3)).toStrictEqual([51, 52, 53])
  })

  it("starts over when the timestamps jump by more than two seconds", () => {
    const jitter = createJitter()
    for (const index of [0, 1, 2]) jitter.push(heard(index), 0)
    for (const index of [500, 501, 502]) jitter.push(heard(index), 20)
    expect(play(jitter, 100, 3)).toStrictEqual([501, 502, 503])
  })

  it("keeps playing across the 32-bit timestamp wrap", () => {
    const jitter = createJitter()
    const near = 2 ** 32 - 160
    jitter.push(heard(0, { timestamp: near }), 0)
    jitter.push(heard(1, { timestamp: 0 }), 0)
    jitter.push(heard(2, { timestamp: 160 }), 0)
    expect(play(jitter, 100, 3)).toStrictEqual([1, 2, 3])
  })

  it("holds at most 50 packets", () => {
    const jitter = createJitter()
    for (let index = 0; index < 60; index++) jitter.push(heard(index), 0)
    expect(play(jitter, 100, 4)).toStrictEqual([48, 49, 50, 0])
  })
})
