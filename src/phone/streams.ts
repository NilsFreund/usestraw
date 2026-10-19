import { SAMPLES_PER_MS } from "../rtp/g711"

const MAX_WAITING_FRAMES = 25
const AHEAD_SAMPLES = 30_000 * SAMPLES_PER_MS

// Where written audio goes: it queues the samples, sends them in time and can drop the rest
export interface PcmSink {
  readonly queued: number
  write(pcm: Int16Array<ArrayBuffer>): void
  clear(): void
}

interface PcmStreams {
  readonly readable: ReadableStream<Int16Array<ArrayBuffer>>
  readonly writable: WritableStream<Int16Array>
  hear(pcm: Int16Array<ArrayBuffer>): void
  // Frames heard before the call was live are not the call
  forget(): void
  // The sink sent or dropped audio, so a waiting writer may go on
  sent(): void
  close(error?: unknown): void
}

// A slow reader loses the oldest frames; a writer waits while 30 s are queued
export function pcmStreams(sink: PcmSink): PcmStreams {
  const waiting: Int16Array<ArrayBuffer>[] = []
  let open = true
  let drained: (() => void) | undefined
  let flushed: PromiseWithResolvers<void> | undefined
  let pulling: ReadableStreamDefaultController<Int16Array<ArrayBuffer>> | undefined
  let frames: ReadableStreamDefaultController<Int16Array<ArrayBuffer>> | undefined
  let writes: WritableStreamDefaultController | undefined

  function hear(pcm: Int16Array<ArrayBuffer>): void {
    if (!open) return
    if (pulling) {
      pulling.enqueue(pcm)
      pulling = undefined
      return
    }
    waiting.push(pcm)
    if (waiting.length > MAX_WAITING_FRAMES) waiting.shift()
  }

  function release(): void {
    drained?.()
    drained = undefined
  }

  function sent(): void {
    if (sink.queued <= AHEAD_SAMPLES) release()
    if (sink.queued > 0) return
    flushed?.resolve()
    flushed = undefined
  }

  function close(error?: unknown): void {
    if (!open) return
    open = false
    if (error === undefined) frames?.close()
    else frames?.error(error)
    const reason = error ?? new DOMException("The call ended", "AbortError")
    writes?.error(reason)
    release()
    flushed?.reject(reason)
    flushed = undefined
  }

  const readable = new ReadableStream<Int16Array<ArrayBuffer>>(
    {
      start: (controller) => {
        frames = controller
      },
      pull: (controller) => {
        const next = waiting.shift()
        if (next) controller.enqueue(next)
        else pulling = controller
      },
      cancel: () => {
        frames = undefined
        pulling = undefined
      },
    },
    { highWaterMark: 0 },
  )
  const writable = new WritableStream<Int16Array>({
    start: (controller) => {
      writes = controller
    },
    write: (pcm) => {
      if (!(pcm instanceof Int16Array)) {
        throw new TypeError("Audio must be an Int16Array of 8 kHz PCM")
      }
      sink.write(new Int16Array(pcm))
      if (!open || sink.queued <= AHEAD_SAMPLES) return undefined
      return new Promise<void>((resolve) => {
        drained = resolve
      })
    },
    close: () => {
      if (sink.queued === 0) return undefined
      flushed = Promise.withResolvers<void>()
      return flushed.promise
    },
    abort: () => sink.clear(),
  })

  function forget(): void {
    waiting.length = 0
  }

  return { readable, writable, hear, forget, sent, close }
}
