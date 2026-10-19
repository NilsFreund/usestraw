import { describe, expect, it } from "vitest"
import { createResampler, type Resampler } from "../../src/web/resample"

function tone(frequency: number, rate: number, seconds = 1): Float32Array {
  return Float32Array.from({ length: rate * seconds }, (_, k) =>
    Math.sin((2 * Math.PI * frequency * k) / rate),
  )
}

function feed(resample: Resampler, input: Float32Array, chunk: number, room = 4096): Float32Array {
  const out: number[] = []
  const buffer = new Float32Array(room)
  for (let start = 0; start < input.length; start += chunk) {
    const count = resample(input.subarray(start, start + chunk), buffer)
    out.push(...buffer.subarray(0, count))
  }
  return Float32Array.from(out)
}

// The level of one frequency in dB, through a Hann window so the edges don't leak
function level(signal: Float32Array, rate: number, frequency: number): number {
  const middle = signal.subarray(Math.round(rate * 0.05), Math.round(rate * 0.95))
  let sine = 0
  let cosine = 0
  let weight = 0
  for (const [k, value] of middle.entries()) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (middle.length - 1))
    const angle = (2 * Math.PI * frequency * k) / rate
    sine += value * hann * Math.sin(angle)
    cosine += value * hann * Math.cos(angle)
    weight += hann
  }
  return 20 * Math.log10((2 * Math.hypot(sine, cosine)) / weight + 1e-12)
}

const RATES = [48_000, 44_100, 24_000, 16_000]

describe("createResampler", () => {
  describe.each(RATES)("between %i Hz and 8 kHz", (rate) => {
    it.each([300, 1000, 2500, 3400])("passes %i Hz unchanged both ways", (frequency) => {
      const down = feed(createResampler(rate, 8000), tone(frequency, rate), 128)
      const up = feed(createResampler(8000, rate), tone(frequency, 8000), 160)
      expect(level(down, 8000, frequency)).toBeCloseTo(0, 1)
      expect(level(up, rate, frequency)).toBeCloseTo(0, 1)
    })

    it.each([4100, 6000, 7900])("keeps %i Hz from folding into the call", (frequency) => {
      const down = feed(createResampler(rate, 8000), tone(frequency, rate), 128)
      expect(level(down, 8000, 8000 - frequency)).toBeLessThan(-75)
    })

    it.each([300, 3400])("leaves no images of %i Hz above 4 kHz", (frequency) => {
      const up = feed(createResampler(8000, rate), tone(frequency, 8000), 160)
      for (const image of [8000 - frequency, 8000 + frequency]) {
        if (image < rate / 2) expect(level(up, rate, image)).toBeLessThan(-75)
      }
    })
  })

  it("gives the same samples whatever the chunk size", () => {
    const input = tone(1234, 44_100)
    const whole = feed(createResampler(44_100, 8000), input, input.length, 10_000)
    expect(feed(createResampler(44_100, 8000), input, 1)).toEqual(whole)
    expect(feed(createResampler(44_100, 8000), input, 128)).toEqual(whole)
  })

  it("keeps what doesn't fit for the next call", () => {
    const resample = createResampler(8000, 48_000)
    const input = tone(440, 8000).subarray(0, 800)
    const small = new Float32Array(100)
    const first = resample(input, small)
    const rest = resample(new Float32Array(0), new Float32Array(10_000))
    const whole = feed(createResampler(8000, 48_000), input, 800, 10_000)
    expect(first).toBe(100)
    expect(first + rest).toBe(whole.length)
  })

  it("keeps time: a click keeps its place, and the last 4 ms wait for more input", () => {
    const click = new Float32Array(48_000)
    click[4800] = 1
    const resample = createResampler(48_000, 8000)
    const out = feed(resample, click, 128)
    const peak = out.indexOf(Math.max(...out))
    expect(peak).toBe(800)
    expect(out.length).toBe(8000 - 32)
  })

  it("runs from its source text alone, as the AudioWorklet loads it", () => {
    const rebuilt = new Function(`return ${createResampler}`)() as typeof createResampler
    const input = tone(1000, 48_000)
    expect(feed(rebuilt(48_000, 8000), input, 128)).toEqual(
      feed(createResampler(48_000, 8000), input, 128),
    )
  })
})
