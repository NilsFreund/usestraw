import { createSocket, type Socket } from "node:dgram"
import { once } from "node:events"
import { isIP } from "node:net"
import { createClock } from "../phone/clock"
import type { CallAudio } from "../phone/platform"
import { secureRandom } from "../phone/random"
import { createMediaEngine, type MediaInput } from "../rtp/engine"
import { SAMPLES_PER_MS } from "../rtp/g711"
import { type Random, randomInt } from "../support/random"

const FIRST_PORT = 16_384
const PORTS = 8192
const ATTEMPTS = 16
const MAX_WAITING_FRAMES = 25
const AHEAD_SAMPLES = 30_000 * SAMPLES_PER_MS

// One UDP socket per call on an even port (RFC 3550 §11), its PCM as Web Streams
export async function openAudio(
  host: string,
  silent: () => void,
  random: Random = secureRandom,
): Promise<CallAudio> {
  const socket = await bindEven(host, random)
  const engine = createMediaEngine(random)
  const clock = createClock()
  const waiting: Int16Array<ArrayBuffer>[] = []
  let open = true
  let drained: (() => void) | undefined
  let flushed: PromiseWithResolvers<void> | undefined
  let pulling: ReadableStreamDefaultController<Int16Array<ArrayBuffer>> | undefined
  let frames: ReadableStreamDefaultController<Int16Array<ArrayBuffer>> | undefined
  let writes: WritableStreamDefaultController | undefined

  function run(input: MediaInput): void {
    if (!open) return
    try {
      for (const output of engine.handle(input, clock.now())) {
        if (output.type === "send") socket.send(output.data, output.to.port, output.to.host)
        else if (output.type === "frame") hear(output.pcm)
        else silent()
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
    flushed?.resolve()
    flushed = undefined
  }

  function close(error?: unknown): void {
    if (!open) return
    open = false
    clock.cancel()
    socket.close()
    if (error === undefined) frames?.close()
    else frames?.error(error)
    const reason = error ?? new DOMException("The call ended", "AbortError")
    writes?.error(reason)
    release()
    flushed?.reject(reason)
    flushed = undefined
  }

  socket.on("message", (data, info) => {
    const from = { host: info.address, port: info.port }
    run({ type: "packet", data: new Uint8Array(data), from })
  })
  // UDP errors such as ICMP unreachable concern one packet, and the socket keeps working
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
      flushed = Promise.withResolvers<void>()
      return flushed.promise
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
    const port = FIRST_PORT + 2 * randomInt(random, PORTS / 2)
    const socket = createSocket(isIP(host) === 6 ? "udp6" : "udp4")
    try {
      socket.bind({ port, address: host, exclusive: true })
      await once(socket, "listening")
      return socket
    } catch (error) {
      socket.close()
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error
    }
  }
  throw new Error(`No free even port for RTP on ${host}`)
}
