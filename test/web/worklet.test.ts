import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "tsdown"
import { describe, expect, it } from "vitest"
import { createResampler } from "../../src/web/resample"
import {
  defineTap,
  type Processor,
  TAP,
  type TapOrder,
  type TapReport,
  tapSource,
} from "../../src/web/worklet"

type Tap = InstanceType<Processor>
type Define = (register: (processor: Processor) => void, rate: number) => void

// The worklet's port, synchronous: orders arrive at once and reports land in a list
function port() {
  const reports: TapReport[] = []
  const end = {
    onmessage: undefined as ((event: { data: TapOrder }) => void) | undefined,
    postMessage: (report: TapReport) => reports.push(report),
  }
  const order = (data: TapOrder) => end.onmessage?.({ data })
  return { end: end as unknown as MessagePort, reports, order }
}

const direct: Define = (register, rate) => {
  const { end } = current
  class Base {
    readonly port = end
  }
  defineTap(register, Base, rate, createResampler)
}

let current = port()

function start(rate = 48_000, define: Define = direct) {
  current = port()
  let made: Processor | undefined
  define((processor) => (made = processor), rate)
  const tap = new (made as Processor)()
  return { tap, ...current, rate }
}

function tone(frequency: number, rate: number, from: number, size = 128, level = 1): Float32Array {
  return Float32Array.from(
    { length: size },
    (_, k) => level * Math.sin((2 * Math.PI * frequency * (from + k)) / rate),
  )
}

function quanta(tap: Tap, count: number, heard?: (from: number) => Float32Array[]): Float32Array {
  const spoken = new Float32Array(count * 128)
  for (let k = 0; k < count; k++) {
    const output = new Float32Array(128)
    tap.process([heard ? heard(k * 128) : []], [[output]])
    spoken.set(output, k * 128)
  }
  return spoken
}

function frames(reports: TapReport[]): Int16Array[] {
  return reports.flatMap((report) => (report.type === "frame" ? [report.pcm] : []))
}

function toSample(value: number): number {
  return Math.max(-32_768, Math.min(32_767, Math.round(value * 32_768)))
}

function peak(samples: ArrayLike<number>): number {
  return Math.max(...Array.from(samples, Math.abs))
}

const say = (length: number) =>
  Int16Array.from({ length }, (_, k) =>
    Math.round(16_000 * Math.sin((2 * Math.PI * 400 * k) / 8000)),
  )

// What every build of the processor has to do, however it was compiled
function behaves(define: Define): void {
  it("sends what the far end says as 20 ms frames of 8 kHz PCM, sample for sample", () => {
    const { tap, reports, rate } = start(48_000, define)
    quanta(tap, 375, (from) => [tone(1000, rate, from, 128, 0.9)])
    const heard = frames(reports)
    expect(heard).toHaveLength(49)
    for (const frame of heard) expect(frame).toHaveLength(160)
    const expected = new Float32Array(8000)
    createResampler(rate, 8000)(tone(1000, rate, 0, rate, 0.9), expected)
    const joined = heard.flatMap((frame) => Array.from(frame))
    expect(joined).toStrictEqual(
      Array.from(Int16Array.from(expected.subarray(0, joined.length), toSample)),
    )
  })

  it("mixes a stereo far end down to mono, and hears silence while nothing is connected", () => {
    const { tap, reports, rate } = start(48_000, define)
    quanta(tap, 30, (from) => [tone(500, rate, from, 128, 0.5), new Float32Array(128)])
    quanta(tap, 30)
    const heard = frames(reports)
    expect(peak(heard[2] ?? [])).toBeGreaterThan(8000)
    expect(peak(heard[2] ?? [])).toBeLessThan(8400)
    expect(heard.at(-1)?.every((sample) => sample === 0)).toBe(true)
  })

  it("plays written audio at the context's rate, then silence, and counts it", () => {
    const { tap, order, reports } = start(44_100, define)
    order({ type: "pcm", pcm: say(800) })
    const spoken = quanta(tap, 60)
    const loud = Array.from(spoken).flatMap((value, k) => (Math.abs(value) > 0.05 ? [k] : []))
    const span = (loud.at(-1) ?? 0) - (loud[0] ?? 0)
    expect(span).toBeGreaterThan(4410 - 40)
    expect(span).toBeLessThan(4410 + 40)
    expect(peak(spoken)).toBeCloseTo(16_000 / 32_768, 2)
    expect(spoken.subarray(-128).every((value) => value === 0)).toBe(true)
    expect(reports.filter((report) => report.type === "sent").at(-1)).toStrictEqual({
      type: "sent",
      taken: 800,
      played: 800,
    })
  })

  it("takes chunks of any size across frames", () => {
    const { tap, order, reports } = start(48_000, define)
    for (const length of [7, 300, 1, 52]) order({ type: "pcm", pcm: new Int16Array(length) })
    quanta(tap, 30)
    expect(reports.filter((report) => report.type === "sent").at(-1)).toMatchObject({ taken: 360 })
  })

  it("drops what is queued on clear as taken, and counts what was on its way once rendered", () => {
    const { tap, order, reports } = start(48_000, define)
    order({ type: "pcm", pcm: new Int16Array(8000) })
    quanta(tap, 3)
    order({ type: "clear" })
    const sent = () => reports.filter((report) => report.type === "sent").at(-1)
    expect(sent()).toStrictEqual({ type: "sent", taken: 7840, played: 0 })
    expect(peak(quanta(tap, 20).subarray(-128))).toBe(0)
    expect(sent()).toStrictEqual({ type: "sent", taken: 8000, played: 160 })
  })
}

describe("defineTap", () => {
  behaves(direct)

  it("fills every output channel, and survives an output with none", () => {
    const { tap } = start()
    const output = [new Float32Array(128), new Float32Array(128).fill(1)]
    expect(tap.process([[]], [output])).toBe(true)
    expect(output[1]?.every((value) => value === 0)).toBe(true)
    expect(tap.process([], [])).toBe(true)
  })

  it("plays the same samples whatever size the render quanta have", () => {
    const steady = start()
    steady.order({ type: "pcm", pcm: say(800) })
    const expected = quanta(steady.tap, 50)
    const varied = start()
    varied.order({ type: "pcm", pcm: say(800) })
    const spoken: number[] = []
    for (const size of [128, 4096, 64, 1024, 1088]) {
      const output = new Float32Array(size)
      varied.tap.process([[]], [[output]])
      spoken.push(...output)
    }
    expect(spoken).toStrictEqual(Array.from(expected))
    expect(varied.reports.filter((report) => report.type === "sent").at(-1)).toMatchObject({
      taken: 800,
    })
  })
})

// The source text runs alone in the worklet's scope, with only these three names given
function fromSource(source: string): Define {
  return (register, rate) => {
    const { end } = current
    class Base {
      readonly port = end
    }
    const load = new Function("registerProcessor", "AudioWorkletProcessor", "sampleRate", source)
    load(
      (name: string, processor: Processor) => {
        expect(name).toBe(TAP)
        register(processor)
      },
      Base,
      rate,
    )
  }
}

describe("tapSource", () => {
  behaves(fromSource(tapSource()))
})

describe.each(["es2015", "es2017", "es2019"])(
  "tapSource after a bundler lowered it to %s",
  (target) => {
    const dir = mkdtempSync(join(tmpdir(), "straw-worklet-"))
    let source = ""

    it("builds", async () => {
      try {
        await build({
          config: false,
          entry: { worklet: "src/web/worklet.ts" },
          outDir: dir,
          target,
          minify: true,
          dts: false,
          platform: "neutral",
          logLevel: "silent",
        })
        const lowered: { tapSource: () => string } = await import(
          pathToFileURL(join(dir, "worklet.js")).href
        )
        source = lowered.tapSource()
      } finally {
        rmSync(dir, { recursive: true })
      }
      expect(source).not.toBe(tapSource())
    })

    behaves((register, rate) => fromSource(source)(register, rate))
  },
)
