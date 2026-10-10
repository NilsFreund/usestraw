import { createSocket, type Socket } from "node:dgram"
import { once } from "node:events"
import { isIP } from "node:net"
import type { Random } from "../core/types"
import { createMediaEngine, type MediaInput } from "../rtp/engine"
import { SAMPLES_PER_MS } from "../rtp/g711"
import type { CallMedia, MediaAddress } from "../sdp/types"
import { createClock } from "./clock"
import { secureRandom } from "./random"

export interface CallAudio {
  readonly local: MediaAddress
  readonly sampleRate: 8000
  readonly played: number
  readonly readable: ReadableStream<Int16Array<ArrayBuffer>>
  readonly writable: WritableStream<Int16Array>
  update(media: CallMedia): void
  clear(): void
  close(): void
}

const FIRST_PORT = 16_384
const PORTS = 8192
const ATTEMPTS = 16
const MAX_WAITING_FRAMES = 25
const AHEAD_SAMPLES = 30_000 * SAMPLES_PER_MS

// One UDP socket per call on an even port (RFC 3550 §11), PCM in and out as Web Streams; a slow
// reader loses the oldest frames, a writer may run 30 s ahead, and clear() drops all of that at once
export async function openAudio(host: string, random: Random = secureRandom): Promise<CallAudio> {
  const socket = await bindEven(host, random)
  const engine = createMediaEngine(random)
  const clock = createClock()
  const waiting: Int16Array<ArrayBuffer>[] = []
  let open = true
  let drained: (() => void) | undefined
  let flushed: (() => void) | undefined
  let pulling: ReadableStreamDefaultController<Int16Array<ArrayBuffer>> | undefined
  let frames: ReadableStreamDefaultController<Int16Array<ArrayBuffer>> | undefined
  let writes: WritableStreamDefaultController | undefined

  function run(input: MediaInput): void {
    if (!open) return
    try {
      for (const output of engine.handle(input, clock.now())) {
        if (output.type === "send") socket.send(output.data, output.to.port, output.to.host)
        else hear(output.pcm)
      }
    } catch (error) {
      close(error)
      return
    }
    if (engine.queued <= AHEAD_SAMPLES) release()
    if (engine.queued === 0) settle()
    clock.schedule(engine.nextDeadline(), () => run({ type: "timeout" }))
  }

  function hear(pcm: Int16Array<ArrayBuffer>): void {
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

  function settle(): void {
    flushed?.()
    flushed = undefined
  }

  function close(error?: unknown): void {
    if (!open) return
    open = false
    clock.cancel()
    socket.close()
    if (error === undefined) frames?.close()
    else frames?.error(error)
    writes?.error(error ?? new DOMException("The call ended", "AbortError"))
    release()
    settle()
  }

  socket.on("message", (data, info) => {
    const from = { host: info.address, port: info.port }
    run({ type: "packet", data: new Uint8Array(data), from })
  })
  socket.on("error", () => undefined)

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
      if (!(pcm instanceof Int16Array))
        throw new TypeError("Audio must be an Int16Array of 8 kHz PCM")
      run({ type: "audio", pcm: new Int16Array(pcm) })
      if (!open || engine.queued <= AHEAD_SAMPLES) return undefined
      return new Promise<void>((resolve) => {
        drained = resolve
      })
    },
    close: () => {
      if (engine.queued === 0) return undefined
      return new Promise<void>((resolve) => {
        flushed = resolve
      })
    },
    abort: () => run({ type: "clear" }),
  })

  return {
    local: { host, port: socket.address().port },
    sampleRate: 8000,
    get played() {
      return engine.played / SAMPLES_PER_MS
    },
    readable,
    writable,
    update: (media) => run({ type: "media", media }),
    clear: () => run({ type: "clear" }),
    close: () => close(),
  }
}

async function bindEven(host: string, random: Random): Promise<Socket> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const port = FIRST_PORT + 2 * Math.floor(random() * (PORTS / 2))
    const socket = createSocket(isIP(host) === 6 ? "udp6" : "udp4")
    try {
      socket.bind(port, host)
      await once(socket, "listening")
      return socket
    } catch (error) {
      socket.close()
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error
    }
  }
  throw new Error(`No free even port for RTP on ${host}`)
}
