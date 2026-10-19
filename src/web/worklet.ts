import { createResampler } from "./resample"

export const TAP = "straw-tap"

// From the page: audio for the far end, or an order to drop what is queued
export type TapOrder =
  | { readonly type: "pcm"; readonly pcm: Int16Array<ArrayBuffer> }
  | { readonly type: "clear" }

// From the worklet: a 20 ms frame the far end said, or how much written audio left the queue
export type TapReport =
  | { readonly type: "frame"; readonly pcm: Int16Array<ArrayBuffer> }
  | { readonly type: "sent"; readonly taken: number; readonly played: number }

interface ProcessorBase {
  readonly port: MessagePort
}

export type Processor = new () => ProcessorBase & {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
}

// What the page loads into its AudioWorklet
export function tapSource(): string {
  const register = `(tap) => registerProcessor(${JSON.stringify(TAP)}, tap)`
  return `(${defineTap})(${register}, AudioWorkletProcessor, sampleRate, ${createResampler})`
}

type Render = (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean

// The worklet gets this function as source text, so everything it needs comes in as arguments.
// Closures and no class fields: an app's bundler that lowers syntax adds no helpers it would miss.
export function defineTap(
  register: (processor: Processor) => void,
  Base: new () => ProcessorBase,
  rate: number,
  resampler: typeof createResampler,
): void {
  const FRAME = 160
  const toFloat = (sample: number): number => sample / 32_768
  const toSample = (value: number): number =>
    Math.max(-32_768, Math.min(32_767, Math.round(value * 32_768)))
  const refilled = Math.ceil((FRAME * rate) / 8000) + 1

  function tap(port: MessagePort): Render {
    const down = resampler(rate, 8000)
    const up = resampler(8000, rate)
    const said = new Float32Array(FRAME)
    const queue: Int16Array[] = []
    let heard = new Float32Array(0)
    let mixed = new Float32Array(0)
    let out = new Float32Array(0)
    let frame = new Int16Array(FRAME)
    let filled = 0
    let start = 0
    let length = 0
    let offset = 0
    let taken = 0
    let played = 0
    let fed = 0
    let rendered = 0
    const leaving: [at: number, count: number][] = []

    port.onmessage = ({ data }: MessageEvent<TapOrder>) => {
      if (data.type === "pcm") queue.push(data.pcm)
      else clear()
    }

    function resize(size: number): void {
      mixed = new Float32Array(size)
      heard = new Float32Array(Math.ceil((size * 8000) / rate) + 2)
      const grown = new Float32Array(size + refilled)
      grown.set(out.subarray(start, start + length))
      out = grown
      start = 0
    }

    // A far end in stereo is mixed down; nothing connected is silence
    function hear(channels: Float32Array[]): void {
      let input = channels[0] ?? mixed.fill(0)
      if (channels.length > 1) {
        input = mixed
        for (let k = 0; k < input.length; k++) {
          let sum = 0
          for (const channel of channels) sum += channel[k] as number
          input[k] = sum / channels.length
        }
      }
      const count = down(input, heard)
      for (let k = 0; k < count; k++) {
        frame[filled++] = toSample(heard[k] as number)
        if (filled < FRAME) continue
        port.postMessage({ type: "frame", pcm: frame } satisfies TapReport, [frame.buffer])
        frame = new Int16Array(FRAME)
        filled = 0
      }
    }

    // 20 ms of written audio, padded with silence once the queue runs dry
    function refill(): void {
      let count = 0
      while (count < FRAME && queue.length > 0) {
        const chunk = queue[0] as Int16Array
        const take = Math.min(FRAME - count, chunk.length - offset)
        for (let k = 0; k < take; k++) said[count + k] = toFloat(chunk[offset + k] as number)
        count += take
        offset += take
        if (offset < chunk.length) continue
        queue.shift()
        offset = 0
      }
      said.fill(0, count)
      fed += FRAME
      leaving.push([Math.ceil(((fed - FRAME + count) * rate) / 8000), count])
      out.copyWithin(0, start, start + length)
      start = 0
      length += up(said, out.subarray(length))
    }

    // Written audio counts once its last sample was rendered, as Node counts it once it was sent
    function settle(): void {
      const before = taken
      while (leaving.length > 0 && (leaving[0] as [number, number])[0] <= rendered) {
        const [, count] = leaving.shift() as [number, number]
        taken += count
        played += count
      }
      if (taken > before) report()
    }

    function clear(): void {
      for (const chunk of queue) taken += chunk.length
      taken -= offset
      queue.length = 0
      offset = 0
      report()
    }

    function report(): void {
      port.postMessage({ type: "sent", taken, played } satisfies TapReport)
    }

    return (inputs, outputs) => {
      const channels = outputs[0] ?? []
      const size = channels[0]?.length ?? 128
      if (mixed.length !== size) resize(size)
      hear(inputs[0] ?? [])
      while (length < size) refill()
      for (const channel of channels) channel.set(out.subarray(start, start + size))
      start += size
      length -= size
      rendered += size
      settle()
      return true
    }
  }

  class Tap extends Base {
    declare readonly render: Render

    constructor() {
      super()
      this.render = tap(this.port)
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      return this.render(inputs, outputs)
    }
  }

  register(Tap)
}
