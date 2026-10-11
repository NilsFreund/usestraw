import { createSocket } from "node:dgram"
import dns from "node:dns"
import { once } from "node:events"
import { isIP } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CallMedia } from "../../src"
import { type CallAudio, openAudio } from "../../src/node/audio"
import { readRtp } from "../../src/rtp/packet"

const opened: CallAudio[] = []
const host = "127.0.0.1"
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function open(): Promise<CallAudio> {
  const audio = await openAudio(host, () => undefined)
  opened.push(audio)
  return audio
}

function towards(audio: CallAudio, overrides: Partial<CallMedia> = {}): CallMedia {
  return {
    remote: audio.local,
    codec: "PCMU",
    payloadType: 0,
    ptime: 20,
    direction: "sendrecv",
    ...overrides,
  }
}

function tone(samples: number): Int16Array {
  return Int16Array.from({ length: samples }, (_, index) =>
    Math.round(8000 * Math.sin((2 * Math.PI * 440 * index) / 8000)),
  )
}

const loudness = (pcm: Int16Array) =>
  Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length)

async function listener() {
  const socket = createSocket("udp4")
  socket.bind(0, host)
  await once(socket, "listening")
  return socket
}

afterEach(() => {
  for (const audio of opened.splice(0)) audio.close()
})

describe("openAudio", () => {
  it("binds an even port for 8 kHz RTP on the given host", async () => {
    const audio = await open()
    expect(audio.local.host).toBe(host)
    expect(audio.local.port % 2).toBe(0)
    expect(audio.local.port).toBeGreaterThanOrEqual(16_384)
    expect(audio.local.port).toBeLessThan(16_384 + 8192)
    expect(audio.sampleRate).toBe(8000)
  })

  it("carries a tone from one call to the other as steady 20 ms frames", async () => {
    const [left, right] = await Promise.all([open(), open()])
    left.update(towards(right))
    right.update(towards(left))
    const writer = left.writable.getWriter()
    void writer.write(tone(8000))
    const reader = right.readable.getReader()
    const frames: Int16Array[] = []
    while (frames.length < 25) {
      const { value } = await reader.read()
      if (value) frames.push(value)
    }
    expect(frames.every((frame) => frame.length === 160)).toBe(true)
    expect(frames.filter((frame) => loudness(frame) > 3000).length).toBeGreaterThan(10)
    reader.releaseLock()
    writer.releaseLock()
  })

  it("lets a writer run 30 s ahead, holds it back beyond that and lets go on clear", async () => {
    const [left, right] = await Promise.all([open(), open()])
    left.update(towards(right))
    const writer = left.writable.getWriter()
    const started = performance.now()
    await writer.write(tone(8000 * 29))
    expect(performance.now() - started).toBeLessThan(100)
    let done = false
    void writer.write(tone(8000 * 2)).then(() => {
      done = true
    })
    await pause(100)
    expect(done).toBe(false)
    left.clear()
    await pause(40)
    expect(done).toBe(true)
  })

  it("counts what it played and closes the writer once the last sample went out", async () => {
    const [left, right] = await Promise.all([open(), open()])
    left.update(towards(right))
    expect(left.played).toBe(0)
    const writer = left.writable.getWriter()
    await writer.write(tone(1600))
    const started = performance.now()
    await writer.close()
    expect(performance.now() - started).toBeGreaterThan(150)
    expect(left.played).toBe(200)
  })

  it("rejects a writer's close when the call ends before the last sample went out", async () => {
    const [left, right] = await Promise.all([open(), open()])
    left.update(towards(right))
    const writer = left.writable.getWriter()
    await writer.write(tone(8000))
    const closing = writer.close()
    await pause(50)
    left.close()
    await expect(closing).rejects.toThrow("The call ended")
  })

  it("closes a writer at once when nothing waits to be played", async () => {
    const audio = await open()
    await audio.writable.getWriter().close()
    expect(audio.played).toBe(0)
  })

  it("ends both streams when the call ends, so pipes stop pulling", async () => {
    const audio = await open()
    const reader = audio.readable.getReader()
    const piped = new ReadableStream<Int16Array>({
      pull: (controller) => controller.enqueue(tone(160)),
    }).pipeTo(audio.writable)
    audio.close()
    audio.close()
    expect(await reader.read()).toStrictEqual({ done: true, value: undefined })
    await expect(piped).rejects.toThrow("The call ended")
  })

  it("throws away a writer's queue when the writer aborts", async () => {
    const socket = await listener()
    const payloads: Uint8Array[] = []
    socket.on("message", (data: Buffer) =>
      payloads.push(readRtp(new Uint8Array(data))?.payload ?? new Uint8Array()),
    )
    const audio = await open()
    audio.update({ ...towards(audio), remote: { host, port: socket.address().port } })
    const writer = audio.writable.getWriter()
    void writer.write(tone(8000)).catch(() => undefined)
    await pause(60)
    await writer.abort()
    const since = payloads.length
    await pause(100)
    const after = payloads.slice(since + 1)
    expect(after.length).toBeGreaterThan(2)
    expect(after.every((payload) => payload.every((byte) => byte === 0xff))).toBe(true)
    socket.close()
  })

  it("keeps the newest frames for a reader that falls behind", async () => {
    const [left, right] = await Promise.all([open(), open()])
    left.update(towards(right))
    right.update(towards(left))
    const writer = left.writable.getWriter()
    void writer.write(tone(1600))
    await pause(1500)
    const reader = right.readable.getReader()
    const frames: Int16Array[] = []
    for (let index = 0; index < 25; index++) {
      const { value } = await reader.read()
      if (value) frames.push(value)
    }
    expect(frames.filter((frame) => loudness(frame) > 3000)).toStrictEqual([])
  })

  it("sends nothing on hold and refuses audio that is not PCM", async () => {
    const socket = await listener()
    let packets = 0
    socket.on("message", () => {
      packets++
    })
    const audio = await open()
    audio.update({
      ...towards(audio, { direction: "recvonly" }),
      remote: { host, port: socket.address().port },
    })
    await pause(100)
    expect(packets).toBe(0)
    const writer = audio.writable.getWriter()
    await expect(writer.write(new Uint8Array(160) as never)).rejects.toThrow(
      "Audio must be an Int16Array of 8 kHz PCM",
    )
    socket.close()
  })

  it("speaks RTP that a plain socket can read", async () => {
    const socket = await listener()
    const audio = await open()
    audio.update({ ...towards(audio), remote: { host, port: socket.address().port } })
    const [data] = (await once(socket, "message")) as [Buffer]
    expect(readRtp(new Uint8Array(data))).toMatchObject({ payloadType: 0, marker: true })
    socket.close()
  })

  it("keeps going when the reader cancels", async () => {
    const [left, right] = await Promise.all([open(), open()])
    left.update(towards(right))
    right.update(towards(left))
    await right.readable.cancel()
    await pause(100)
  })

  it("ends its streams with the error when sending fails outright", async () => {
    const audio = await open()
    const reader = audio.readable.getReader()
    audio.update(towards(audio, { remote: { host, port: 70_000 } }))
    await expect(
      (async () => {
        for (;;) await reader.read()
      })(),
    ).rejects.toThrow(/port/i)
    await expect(audio.writable.getWriter().write(tone(160))).rejects.toThrow(/port/i)
  })

  it("survives a send error reported later, and ignores everything after close", async () => {
    const lookup = dns.lookup
    const failing = vi
      .spyOn(dns, "lookup")
      .mockImplementation(((
        name: string,
        family: number,
        callback: (error: Error | null, address?: string, family?: number) => void,
      ) =>
        isIP(name)
          ? lookup(name, family, callback)
          : callback(
              Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" }),
            )) as typeof dns.lookup)
    try {
      const audio = await open()
      audio.update(towards(audio, { remote: { host: "media.invalid", port: 4000 } }))
      await vi.waitFor(() =>
        expect(failing.mock.calls.some(([name]) => name === "media.invalid")).toBe(true),
      )
      audio.close()
      audio.update(towards(audio))
      audio.clear()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it("gives up when no even port is free, and reports other bind errors as they are", async () => {
    const blocker = createSocket("udp4")
    blocker.bind(16_384, host)
    await once(blocker, "listening")
    await expect(
      openAudio(
        host,
        () => undefined,
        () => 0,
      ),
    ).rejects.toThrow("No free even port for RTP on 127.0.0.1")
    blocker.close()
    await expect(openAudio("192.0.2.1", () => undefined)).rejects.toMatchObject({
      code: "EADDRNOTAVAIL",
    })
  })

  it("binds IPv6 hosts too", async () => {
    const audio = await openAudio("::1", () => undefined)
    expect(audio.local).toMatchObject({ host: "::1" })
    audio.close()
  })
})
