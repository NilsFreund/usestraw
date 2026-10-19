import { createSocket, type Socket } from "node:dgram"
import { once } from "node:events"
import { isIP } from "node:net"
import { createClock } from "../phone/clock"
import type { RtpAudio } from "../phone/platform"
import { secureRandom } from "../phone/random"
import { pcmStreams } from "../phone/streams"
import { createMediaEngine, type MediaInput } from "../rtp/engine"
import { SAMPLE_RATE, SAMPLES_PER_MS } from "../rtp/g711"
import { type Random, randomInt } from "../support/random"

const FIRST_PORT = 16_384
const PORTS = 8192
const ATTEMPTS = 16

// One UDP socket per call on an even port (RFC 3550 §11), its PCM as Web Streams
export async function openAudio(
  host: string,
  silent: () => void,
  random: Random = secureRandom,
): Promise<RtpAudio> {
  const socket = await bindEven(host, random)
  const engine = createMediaEngine(random)
  const clock = createClock()
  const streams = pcmStreams({
    get queued() {
      return engine.queued
    },
    write: (pcm) => run({ type: "audio", pcm }),
    clear: () => run({ type: "clear" }),
  })
  let open = true

  function run(input: MediaInput): void {
    if (!open) return
    try {
      for (const output of engine.handle(input, clock.now())) {
        if (output.type === "send") socket.send(output.data, output.to.port, output.to.host)
        else if (output.type === "frame") streams.hear(output.pcm)
        else silent()
      }
    } catch (error) {
      close(error)
      return
    }
    streams.sent()
    clock.schedule(engine.nextDeadline(), () => run({ type: "timeout" }))
  }

  function close(error?: unknown): void {
    if (!open) return
    open = false
    clock.cancel()
    socket.close()
    streams.close(error)
  }

  socket.on("message", (data, info) => {
    const from = { host: info.address, port: info.port }
    run({ type: "packet", data: new Uint8Array(data), from })
  })
  // UDP errors such as ICMP unreachable concern one packet, and the socket keeps working
  socket.on("error", () => undefined)

  return {
    local: { host, port: socket.address().port },
    sampleRate: SAMPLE_RATE,
    get played() {
      return engine.played / SAMPLES_PER_MS
    },
    readable: streams.readable,
    writable: streams.writable,
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
      if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error
    }
  }
  throw new Error(`No free even port for RTP on ${host}`)
}
