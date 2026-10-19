import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openTap, type Tap, type TapOutput } from "../../src/web/tap"
import { TAP } from "../../src/web/worklet"
import {
  FakeAudioContext,
  type FakeMedia,
  FakeSender,
  FakeStream,
  type FakeTrack,
  FakeWorkletNode,
  fakeMedia,
} from "./fakes"

const taps: Tap[] = []

beforeEach(() => {
  FakeWorkletNode.last = undefined
  FakeAudioContext.failLoad = undefined
  FakeAudioContext.failCreate = undefined
  FakeAudioContext.blocked = false
})

afterEach(() => {
  for (const tap of taps.splice(0)) tap.close()
  vi.restoreAllMocks()
})

interface Opening {
  readonly sender?: FakeSender
  readonly media?: FakeMedia
  readonly microphone?: FakeStream
  readonly agent?: boolean
}

// A softphone's tap unless an agent talks: the microphone goes out until the app speaks
function open({
  sender = new FakeSender(null),
  media = fakeMedia(),
  microphone = new FakeStream(),
  agent = false,
}: Opening = {}): Tap {
  const output = {
    microphone: agent ? undefined : microphone,
    send: (track: FakeTrack) => sender.replaceTrack(track),
  }
  const tap = openTap(media, output as unknown as TapOutput)
  taps.push(tap)
  return tap
}

async function worklet(): Promise<FakeWorkletNode> {
  return vi.waitFor(() => {
    if (!FakeWorkletNode.last) throw new Error("The worklet has not loaded yet")
    return FakeWorkletNode.last
  })
}

function context(): FakeAudioContext {
  if (!FakeAudioContext.last) throw new Error("No audio context was made")
  return FakeAudioContext.last
}

function tone(from: number): Float32Array {
  return Float32Array.from({ length: 128 }, (_, k) =>
    Math.sin((2 * Math.PI * 1000 * (from + k)) / 48_000),
  )
}

function render(node: FakeWorkletNode, quanta: number): void {
  for (let k = 0; k < quanta; k++) node.render([tone(k * 128)])
}

describe("openTap", () => {
  it("loads the processor from its own source and sends mono into the call", async () => {
    const revoked = vi.spyOn(URL, "revokeObjectURL")
    await open().ready
    const node = await worklet()
    expect(context().options).toStrictEqual({ latencyHint: "interactive" })
    expect(context().loaded).toHaveLength(1)
    expect(revoked).toHaveBeenCalledWith(context().loaded[0])
    expect(node.name).toBe(TAP)
    expect(node.options).toStrictEqual({ outputChannelCount: [1] })
    expect(node.connected).toStrictEqual([context().destination])
  })

  it("hears the far end as 20 ms frames of 8 kHz PCM, from a stream given before or after", async () => {
    const tap = open()
    const first = new FakeStream()
    tap.hear(first as unknown as MediaStream)
    const node = await worklet()
    expect(context().sources[0]?.connected).toStrictEqual([node])
    tap.hear(new FakeStream() as unknown as MediaStream)
    expect(context().sources[0]?.disconnected).toBe(true)
    expect(context().sources[1]?.connected).toStrictEqual([node])
    render(node, 30)
    const reader = tap.readable.getReader()
    const { value } = await reader.read()
    expect(value?.length).toBe(160)
  })

  it("plays what the app writes, even before the worklet is ready, and counts it", async () => {
    const tap = open()
    const writer = tap.writable.getWriter()
    await writer.write(new Int16Array(800).fill(8000))
    const node = await worklet()
    await vi.waitFor(() => {
      if (node.render().every((value) => value === 0)) throw new Error("Nothing played yet")
    })
    render(node, 40)
    await vi.waitFor(() => expect(tap.played).toBe(100))
  })

  it("holds a writer that is 30 s ahead until the call catches up", async () => {
    const tap = open()
    const node = await worklet()
    const writer = tap.writable.getWriter()
    let written = false
    void writer.write(new Int16Array(240_001)).then(() => (written = true))
    await Promise.resolve()
    expect(written).toBe(false)
    await vi.waitFor(() => {
      render(node, 10)
      expect(written).toBe(true)
    })
  })

  it("closes a writer once the last sample went out", async () => {
    const tap = open()
    const node = await worklet()
    const writer = tap.writable.getWriter()
    await writer.write(new Int16Array(400))
    let closed = false
    void writer.close().then(() => (closed = true))
    await vi.waitFor(() => {
      render(node, 10)
      expect(closed).toBe(true)
    })
    expect(tap.played).toBe(50)
  })

  it("settles a pending close when clear drops the rest", async () => {
    const tap = open()
    const node = await worklet()
    const writer = tap.writable.getWriter()
    await writer.write(new Int16Array(8000))
    let closed = false
    const closing = writer.close().then(() => (closed = true))
    await vi.waitFor(() => {
      node.render()
      expect(tap.played).toBeGreaterThan(0)
    })
    expect(closed).toBe(false)
    tap.clear()
    await vi.waitFor(() => {
      node.render()
      expect(closed).toBe(true)
    })
    await closing
    expect(tap.played).toBeLessThan(1000)
  })

  it("drops what is queued when the writer aborts", async () => {
    const tap = open()
    const node = await worklet()
    const writer = tap.writable.getWriter()
    await writer.write(new Int16Array(8000))
    await writer.abort(new Error("barge-in"))
    await vi.waitFor(() => {
      node.render()
      expect(node.render().every((value) => value === 0)).toBe(true)
    })
    expect(tap.played).toBeLessThan(1000)
  })

  it("sends the microphone mixed with written audio once the app first speaks", async () => {
    const sender = new FakeSender(null)
    const microphone = new FakeStream()
    const tap = open({ sender, microphone })
    expect(sender.replaced).toStrictEqual([])
    const writer = tap.writable.getWriter()
    await writer.write(new Int16Array(160))
    await writer.write(new Int16Array(160))
    expect(context().sources[0]?.stream).toBe(microphone)
    expect(context().sources[0]?.connected).toStrictEqual([context().destination])
    expect(sender.replaced).toStrictEqual([context().destination.stream.tracks[0]])
  })

  it("sends an agent's audio from the start, and shrugs off a sender that refuses", async () => {
    const sender = new FakeSender(null)
    open({ sender, agent: true })
    expect(sender.replaced).toStrictEqual([context().destination.stream.tracks[0]])
    const closed = Object.assign(new FakeSender(null), { refuse: true })
    expect(() => open({ sender: closed, agent: true })).not.toThrow()
  })

  it("ends its streams and the context with the call, also while the worklet loads", async () => {
    const tap = open()
    const reader = tap.readable.getReader()
    tap.close()
    tap.close()
    expect(await reader.read()).toStrictEqual({ done: true, value: undefined })
    await tap.ready
    expect(context().state).toBe("closed")
    expect(FakeWorkletNode.last).toBeUndefined()
    tap.hear(new FakeStream() as unknown as MediaStream)
    expect(context().sources).toHaveLength(0)
  })

  it("ends quietly when the browser closed its context first", async () => {
    const tap = open()
    await context().close()
    expect(() => tap.close()).not.toThrow()
    await tap.ready
  })

  it("fails its streams when the browser has no AudioWorklet", async () => {
    const sender = new FakeSender(null)
    const tap = open({ sender, media: fakeMedia({ webAudio: false }), agent: true })
    await expect(tap.ready).rejects.toMatchObject({ name: "NotSupportedError" })
    await expect(tap.readable.getReader().read()).rejects.toMatchObject({
      name: "NotSupportedError",
    })
    expect(sender.replaced).toStrictEqual([])
    expect(() => tap.hear(new FakeStream() as unknown as MediaStream)).not.toThrow()
  })

  it("says what to allow when the page may not load the worklet", async () => {
    FakeAudioContext.failLoad = new DOMException("Unable to load a worklet's module", "AbortError")
    const tap = open()
    const blocked = {
      name: "SecurityError",
      message: expect.stringMatching(
        /\(AbortError: Unable to load a worklet's module\).*allow blob: in script-src/,
      ),
    }
    await expect(tap.ready).rejects.toMatchObject(blocked)
    await expect(tap.readable.getReader().read()).rejects.toMatchObject(blocked)
    expect(context().state).toBe("closed")
  })

  it("fails its streams with the browser's reason when it can't make a context", async () => {
    const reason = new DOMException("too many contexts", "NotSupportedError")
    FakeAudioContext.failCreate = reason
    const tap = open({ agent: true })
    await expect(tap.ready).rejects.toBe(reason)
    await expect(tap.readable.getReader().read()).rejects.toBe(reason)
  })

  it("keeps the microphone on its own path until the context runs", async () => {
    FakeAudioContext.blocked = true
    const media = fakeMedia()
    const sender = new FakeSender(null)
    const tap = open({ media, sender })
    await tap.writable.getWriter().write(new Int16Array(160))
    expect(sender.replaced).toStrictEqual([])
    context().interrupt()
    expect(sender.replaced).toStrictEqual([])
    FakeAudioContext.blocked = false
    media.page.dispatchEvent(new Event("pointerdown"))
    expect(sender.replaced).toStrictEqual([context().destination.stream.tracks[0]])
    context().interrupt("running")
    expect(sender.replaced).toHaveLength(1)
  })

  it("sends nothing for a microphone whose call ended before the context ran", async () => {
    FakeAudioContext.blocked = true
    const sender = new FakeSender(null)
    const tap = open({ sender })
    await tap.writable.getWriter().write(new Int16Array(160))
    const waiting = context()
    tap.close()
    waiting.state = "suspended"
    waiting.interrupt("running")
    expect(sender.replaced).toStrictEqual([])
  })

  it("forgets the frames it heard before the call was live", async () => {
    const tap = open({ agent: true })
    tap.hear(new FakeStream() as unknown as MediaStream)
    const node = await worklet()
    for (let k = 0; k < 60; k++) node.render([tone(k * 128)])
    const writer = tap.writable.getWriter()
    await writer.write(new Int16Array(160))
    await vi.waitFor(() => {
      node.render()
      expect(tap.played).toBe(20)
    })
    tap.forget()
    for (let k = 0; k < 10; k++) node.render()
    const { value } = await tap.readable.getReader().read()
    expect(value?.every((sample) => sample === 0)).toBe(true)
  })

  it("lets a suspended context run on the next click or key, and stops asking with the call", async () => {
    FakeAudioContext.blocked = true
    const media = fakeMedia()
    const tap = open({ media })
    expect(context().resumes).toBe(1)
    media.page.dispatchEvent(new Event("pointerdown"))
    expect(context().resumes).toBe(2)
    FakeAudioContext.blocked = false
    media.page.dispatchEvent(new Event("keydown"))
    expect(context().state).toBe("running")
    media.page.dispatchEvent(new Event("touchend"))
    expect(context().resumes).toBe(3)
    tap.close()
    context().state = "suspended"
    media.page.dispatchEvent(new Event("pointerdown"))
    expect(context().resumes).toBe(3)
  })

  it("asks again when the browser pauses the context for something else", () => {
    open()
    expect(context().resumes).toBe(0)
    context().interrupt()
    expect(context().resumes).toBe(1)
    context().refuseResume = true
    expect(() => context().interrupt("suspended")).not.toThrow()
    expect(context().resumes).toBe(2)
  })
})
