import { describe, expect, it } from "vitest"
import { type PcmSink, pcmStreams } from "../../src/phone/streams"

// A sink that holds what it gets until a test sends it
function sink(): PcmSink & { send(samples: number): void; readonly got: Int16Array[] } {
  const got: Int16Array[] = []
  let queued = 0
  return {
    got,
    get queued() {
      return queued
    },
    write: (pcm) => {
      got.push(pcm)
      queued += pcm.length
    },
    clear: () => {
      queued = 0
    },
    send: (samples) => {
      queued -= samples
    },
  }
}

describe("pcmStreams", () => {
  it("hands frames to a waiting reader at once and keeps half a second for a slow one", async () => {
    const streams = pcmStreams(sink())
    const reader = streams.readable.getReader()
    const waiting = reader.read()
    streams.hear(Int16Array.of(1))
    expect(await waiting).toStrictEqual({ done: false, value: Int16Array.of(1) })
    for (let k = 2; k <= 30; k++) streams.hear(Int16Array.of(k))
    expect((await reader.read()).value).toStrictEqual(Int16Array.of(6))
  })

  it("copies what is written and holds a writer while 30 s are queued", async () => {
    const out = sink()
    const streams = pcmStreams(out)
    const writer = streams.writable.getWriter()
    const pcm = new Int16Array(240_001)
    let written = false
    void writer.write(pcm).then(() => (written = true))
    await expect.poll(() => out.got.length).toBe(1)
    expect(out.got[0]).not.toBe(pcm)
    streams.sent()
    await Promise.resolve()
    expect(written).toBe(false)
    out.send(1)
    streams.sent()
    await expect.poll(() => written).toBe(true)
  })

  it("refuses anything but Int16Array PCM", async () => {
    const writer = pcmStreams(sink()).writable.getWriter()
    await expect(writer.write(new Float32Array(160) as never)).rejects.toThrow(
      "Audio must be an Int16Array of 8 kHz PCM",
    )
  })

  it("closes the writer once the last sample is out, and drops the rest on abort", async () => {
    const out = sink()
    const streams = pcmStreams(out)
    const writer = streams.writable.getWriter()
    await writer.write(new Int16Array(160))
    let closed = false
    const closing = writer.close().then(() => (closed = true))
    streams.sent()
    await Promise.resolve()
    expect(closed).toBe(false)
    out.send(160)
    streams.sent()
    await closing
    const other = pcmStreams(out)
    const aborting = other.writable.getWriter()
    await aborting.write(new Int16Array(160))
    await aborting.abort()
    expect(out.queued).toBe(0)
  })

  it("ends both streams with the call, or with what went wrong, once", async () => {
    const ended = pcmStreams(sink())
    const reader = ended.readable.getReader()
    const writer = ended.writable.getWriter()
    ended.close()
    ended.close(new Error("late"))
    expect(await reader.read()).toStrictEqual({ done: true, value: undefined })
    await expect(writer.write(new Int16Array(1))).rejects.toMatchObject({ name: "AbortError" })
    const failed = pcmStreams(sink())
    const broken = new Error("socket gone")
    failed.close(broken)
    await expect(failed.readable.getReader().read()).rejects.toBe(broken)
  })

  it("forgets what it heard before the call was live", async () => {
    const streams = pcmStreams(sink())
    streams.hear(Int16Array.of(1))
    streams.hear(Int16Array.of(2))
    streams.forget()
    streams.hear(Int16Array.of(3))
    expect((await streams.readable.getReader().read()).value).toStrictEqual(Int16Array.of(3))
  })

  it("ignores frames and sends that arrive after the end, even with a read waiting", async () => {
    const streams = pcmStreams(sink())
    const waiting = streams.readable.getReader().read()
    await Promise.resolve()
    streams.close()
    expect(() => streams.hear(Int16Array.of(2))).not.toThrow()
    expect(() => streams.sent()).not.toThrow()
    expect(await waiting).toStrictEqual({ done: true, value: undefined })
  })

  it("rejects a pending close and releases a held writer when the call ends", async () => {
    const out = sink()
    const streams = pcmStreams(out)
    const writer = streams.writable.getWriter()
    const held = writer.write(new Int16Array(240_001))
    await expect.poll(() => out.got.length).toBe(1)
    const closing = writer.close()
    streams.close()
    await held
    await expect(closing).rejects.toMatchObject({ name: "AbortError" })
  })
})
