import { afterEach, describe, expect, it, vi } from "vitest"
import { browserMedia, openPeerAudio } from "../../src/web/peer"
import {
  FakeAudioContext,
  FakePeer,
  type FakePlayer,
  FakeStream,
  FakeTrack,
  FakeTransceiver,
  type FakeWorkletNode,
  fakeMedia,
} from "./fakes"

const offer = { type: "offer", sdp: "v=0\r\nfar\r\n" } as const
const TALK = { microphone: true }

function peer(): FakePeer {
  if (!FakePeer.last) throw new Error("No peer connection was made")
  return FakePeer.last
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("openPeerAudio", () => {
  it("sends the microphone, with the browser's voice processing, to the ICE servers given", async () => {
    const media = fakeMedia()
    const servers = [{ urls: "stun:stun.example.com" }]
    await openPeerAudio(media, servers, () => undefined, TALK)
    expect(media.asked).toStrictEqual([
      { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
    ])
    expect(peer().configuration).toStrictEqual({ iceServers: servers })
    expect(peer().added).toStrictEqual([[media.microphone.tracks[0], media.microphone]])
  })

  it("passes on a refused microphone", async () => {
    const refused = new DOMException("Permission denied", "NotAllowedError")
    await expect(
      openPeerAudio(fakeMedia({ refuse: refused }), [], () => undefined, TALK),
    ).rejects.toBe(refused)
  })

  it("lets go of the microphone when the browser refuses the ICE servers", async () => {
    const refused = new DOMException("TURN needs a credential", "InvalidAccessError")
    const media = {
      ...fakeMedia(),
      RTCPeerConnection: class {
        constructor() {
          throw refused
        }
      } as never,
    }
    await expect(openPeerAudio(media, [], () => undefined, TALK)).rejects.toBe(refused)
    expect(media.microphone.tracks.every((track) => track.stopped)).toBe(true)
  })

  it("answers an offer and makes one, once ICE gathered its candidates", async () => {
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined, TALK)
    expect(await audio.describe(offer)).toBe("v=0\r\nlocal\r\n")
    expect(peer().calls).toStrictEqual(["remote offer", "local implicit"])
    const other = await openPeerAudio(fakeMedia(), [], () => undefined, TALK)
    expect(await other.describe()).toBe("v=0\r\nlocal\r\n")
    expect(peer().calls).toStrictEqual(["local implicit"])
  })

  it("gives ICE a second at most, and nothing when it is done already", async () => {
    vi.useFakeTimers()
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined, TALK)
    peer().gathers = false
    const describing = audio.describe(offer)
    await vi.advanceTimersByTimeAsync(999)
    let done = false
    void describing.then(() => (done = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await describing).toBe("v=0\r\nlocal\r\n")
    peer().iceGatheringState = "complete"
    expect(await audio.describe()).toBe("v=0\r\nlocal\r\n")
  })

  it("returns as soon as ICE finishes, without waiting out the second", async () => {
    vi.useFakeTimers()
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined, TALK)
    peer().gathers = false
    const describing = audio.describe(offer)
    await vi.advanceTimersByTimeAsync(10)
    peer().gather()
    expect(await describing).toBe("v=0\r\nlocal\r\n")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("ignores gathering news that is not the end, and fails without a description", async () => {
    vi.useFakeTimers()
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined, TALK)
    peer().gathers = false
    const describing = audio.describe()
    const failed = expect(describing).rejects.toMatchObject({ name: "OperationError" })
    await vi.advanceTimersByTimeAsync(10)
    peer().iceGatheringState = "gathering"
    peer().dispatchEvent(new Event("icegatheringstatechange"))
    peer().localDescription = null
    await vi.advanceTimersByTimeAsync(1000)
    await failed
  })

  it("answers with audio alone, refusing whatever else the far end offered", async () => {
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined, TALK)
    const voice = new FakeTransceiver("audio")
    const video = new FakeTransceiver("video")
    peer().transceivers.push(voice, video)
    await audio.describe()
    expect(video.stopped).toBe(false)
    await audio.apply({ type: "rollback" })
    await audio.describe(offer)
    expect([voice.stopped, video.stopped]).toStrictEqual([false, true])
  })

  it("applies answers and rolls back whichever side began", async () => {
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined, TALK)
    const rollback = { type: "rollback" } as const
    await audio.apply(rollback)
    await audio.describe()
    await audio.apply(rollback)
    await audio.apply({ type: "offer", sdp: "v=0\r\n" })
    await audio.apply(rollback)
    await audio.apply({ type: "answer", sdp: "v=0\r\n" })
    await audio.describe()
    await audio.apply({ type: "pranswer", sdp: "v=0\r\n" })
    await audio.apply(rollback)
    expect(peer().calls).toStrictEqual([
      "local implicit",
      "local rollback",
      "remote offer",
      "remote rollback",
      "remote answer",
      "local implicit",
      "remote pranswer",
    ])
  })

  it("plays the far end, with or without a stream, and swallows a blocked autoplay", async () => {
    const media = fakeMedia()
    await openPeerAudio(media, [], () => undefined, TALK)
    const stream = new FakeStream()
    peer().track([stream])
    expect(media.players[0]?.srcObject).toBe(stream)
    const track = new FakeTrack()
    peer().track([], track)
    const shown = media.players[0]?.srcObject as unknown as FakeStream | undefined
    expect(shown?.tracks).toStrictEqual([track])
    peer().track([new FakeStream()], new FakeTrack("video"))
    expect(media.players[0]?.srcObject).toBe(shown)
    expect(media.players[0]?.played).toBe(2)
    const blocked = fakeMedia()
    const player = {
      srcObject: null,
      play: () => Promise.reject(new DOMException("blocked", "NotAllowedError")),
    }
    blocked.createPlayer = () => player
    await openPeerAudio(blocked, [], () => undefined, TALK)
    expect(() => peer().track([stream])).not.toThrow()
  })

  it("drops the call when the connection fails, not when it merely wobbles", async () => {
    const silent = vi.fn()
    await openPeerAudio(fakeMedia(), [], silent, TALK)
    peer().connection("disconnected")
    expect(silent).not.toHaveBeenCalled()
    peer().connection("failed")
    expect(silent).toHaveBeenCalledOnce()
  })

  it("has nothing to clear while it plays no written audio", async () => {
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined, TALK)
    expect(() => audio.clear()).not.toThrow()
  })

  it("closes the connection, stops the microphone and silences the speaker", async () => {
    const media = fakeMedia()
    const audio = await openPeerAudio(media, [], () => undefined, TALK)
    peer().track([new FakeStream()])
    audio.close()
    expect(peer().calls).toStrictEqual(["close"])
    expect(media.microphone.tracks.every((track) => track.stopped)).toBe(true)
    expect(media.players[0]?.srcObject).toBeNull()
  })

  it("ends its audio streams with the call", async () => {
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined, TALK)
    const writer = audio.writable.getWriter()
    await writer.write(new Int16Array(160))
    audio.close()
    expect(await audio.readable.getReader().read()).toStrictEqual({ done: true, value: undefined })
    await expect(writer.write(new Int16Array(160))).rejects.toMatchObject({ name: "AbortError" })
    expect(() => audio.close()).not.toThrow()
  })

  it("leaves the microphone alone for an agent, which sends through the tap from the start", async () => {
    const media = fakeMedia()
    const audio = await openPeerAudio(media, [], () => undefined, { microphone: false })
    expect(media.asked).toStrictEqual([])
    const context = FakeAudioContext.last
    expect(context?.nodes).toHaveLength(1)
    expect(peer().added).toStrictEqual([[context?.destination.stream.tracks[0], undefined]])
    const remote = new FakeStream()
    peer().track([remote])
    expect(context?.sources[0]?.stream).toBe(remote)
    audio.close()
  })

  it("closes the connection when the browser can't make an agent's audio context", async () => {
    FakeAudioContext.failCreate = new DOMException("too many contexts", "NotSupportedError")
    await expect(
      openPeerAudio(fakeMedia(), [], () => undefined, { microphone: false }),
    ).rejects.toMatchObject({ name: "NotSupportedError" })
    FakeAudioContext.failCreate = undefined
    expect(peer().calls).toStrictEqual(["close"])
  })

  it("forgets what an agent heard while the call rang", async () => {
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined, { microphone: false })
    peer().track([new FakeStream()])
    const node = FakeAudioContext.last?.nodes[0] as FakeWorkletNode
    const ringback = Float32Array.from({ length: 128 }, (_, k) => Math.sin(k / 3))
    for (let k = 0; k < 60; k++) node.render([ringback])
    await audio.writable.getWriter().write(new Int16Array(160))
    await vi.waitFor(() => {
      node.render()
      expect(audio.played).toBe(20)
    })
    audio.live()
    for (let k = 0; k < 10; k++) node.render()
    const { value } = await audio.readable.getReader().read()
    expect(value?.every((sample) => sample === 0)).toBe(true)
    audio.close()
    const plain = await openPeerAudio(fakeMedia(), [], () => undefined, TALK)
    expect(() => plain.live()).not.toThrow()
    plain.close()
  })

  it("turns an agent's call down before it goes out when the page can't run call.audio", async () => {
    await expect(
      openPeerAudio(fakeMedia({ webAudio: false }), [], () => undefined, { microphone: false }),
    ).rejects.toMatchObject({ name: "NotSupportedError" })
    expect(peer().calls).toStrictEqual(["close"])
    FakeAudioContext.failLoad = new DOMException("Unable to load a worklet's module", "AbortError")
    await expect(
      openPeerAudio(fakeMedia(), [], () => undefined, { microphone: false }),
    ).rejects.toMatchObject({ name: "SecurityError" })
    FakeAudioContext.failLoad = undefined
  })

  it("taps a call only when asked, and mixes the microphone in once the app speaks", async () => {
    const media = fakeMedia()
    FakeAudioContext.forget()
    const audio = await openPeerAudio(media, [], () => undefined, TALK)
    const sender = peer().senders[0]
    expect(sender?.track).toBe(media.microphone.tracks[0])
    expect(audio.played).toBe(0)
    const remote = new FakeStream()
    peer().track([remote])
    expect(FakeAudioContext.last).toBeUndefined()
    const writer = audio.writable.getWriter()
    expect(FakeAudioContext.last?.sources[0]?.stream).toBe(remote)
    expect(sender?.replaced).toStrictEqual([])
    await writer.write(new Int16Array(160))
    await writer.write(new Int16Array(160))
    const mixed = FakeAudioContext.last?.sources[1]
    expect(mixed?.stream).toBe(media.microphone)
    expect(sender?.replaced).toStrictEqual([FakeAudioContext.last?.destination.stream.tracks[0]])
    const later = new FakeStream()
    peer().track([later])
    expect(FakeAudioContext.last?.sources[2]?.stream).toBe(later)
    expect(() => audio.clear()).not.toThrow()
    audio.close()
  })

  it("gives finished streams to an app that taps a call after it ended, without Web Audio", async () => {
    FakeAudioContext.forget()
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined, TALK)
    audio.close()
    expect(await audio.readable.getReader().read()).toStrictEqual({ done: true, value: undefined })
    await expect(audio.writable.getWriter().write(new Int16Array(1))).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(() => audio.clear()).not.toThrow()
    expect(audio.played).toBe(0)
    expect(FakeAudioContext.last).toBeUndefined()
  })

  it("plays the far end from the next click when autoplay refused, and stops waiting with the call", async () => {
    const media = fakeMedia()
    const audio = await openPeerAudio(media, [], () => undefined, TALK)
    const player = media.players[0] as FakePlayer
    player.blocked = true
    peer().track([new FakeStream()])
    await expect.poll(() => player.played).toBe(0)
    media.page.dispatchEvent(new Event("pointerdown"))
    await Promise.resolve()
    player.blocked = false
    media.page.dispatchEvent(new Event("keydown"))
    await expect.poll(() => player.played).toBe(1)
    media.page.dispatchEvent(new Event("keydown"))
    player.blocked = true
    peer().track([new FakeStream()])
    await Promise.resolve()
    audio.close()
    player.blocked = false
    media.page.dispatchEvent(new Event("pointerdown"))
    expect(player.played).toBe(1)
    const late = await openPeerAudio(media, [], () => undefined, TALK)
    const next = media.players[1] as FakePlayer
    next.blocked = true
    peer().track([new FakeStream()])
    late.close()
    await Promise.resolve()
    await Promise.resolve()
    next.blocked = false
    media.page.dispatchEvent(new Event("pointerdown"))
    expect(next.played).toBe(0)
  })

  it("closes even after the app stopped reading its stream", async () => {
    const media = fakeMedia()
    const audio = await openPeerAudio(media, [], () => undefined, TALK)
    await audio.readable.cancel()
    expect(() => audio.close()).not.toThrow()
    expect(media.microphone.tracks.every((track) => track.stopped)).toBe(true)
  })
})

describe("browserMedia", () => {
  it("takes the browser's own classes and devices", async () => {
    const getUserMedia = vi.fn(async () => "stream")
    vi.stubGlobal("RTCPeerConnection", FakePeer)
    vi.stubGlobal("MediaStream", FakeStream)
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } })
    vi.stubGlobal("Audio", class {})
    const media = browserMedia()
    expect(media.RTCPeerConnection).toBe(FakePeer)
    expect(media.MediaStream).toBe(FakeStream)
    expect(await media.getUserMedia({ audio: true })).toBe("stream")
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(media.createPlayer()).toBeInstanceOf(globalThis.Audio)
  })

  it("refuses a page that isn't secure, since browsers keep the microphone from it", () => {
    vi.stubGlobal("isSecureContext", false)
    expect(() => browserMedia()).toThrow(
      expect.objectContaining({
        name: "SecurityError",
        message: "Calls need a secure page: serve it over https or from localhost",
      }),
    )
  })

  it.each([
    ["no RTCPeerConnection", { mediaDevices: {} }, undefined],
    ["no microphones to ask for", {}, FakePeer],
    ["no navigator", undefined, FakePeer],
  ])("refuses a browser with %s", (_, navigator, peer) => {
    vi.stubGlobal("isSecureContext", true)
    vi.stubGlobal("navigator", navigator)
    vi.stubGlobal("RTCPeerConnection", peer)
    expect(() => browserMedia()).toThrow(
      expect.objectContaining({
        name: "NotSupportedError",
        message: "This browser cannot make calls: it has no WebRTC",
      }),
    )
  })
})
