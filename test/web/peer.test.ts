import { afterEach, describe, expect, it, vi } from "vitest"
import { browserMedia, openPeerAudio } from "../../src/web/peer"
import { FakePeer, FakeStream, FakeTrack, FakeTransceiver, fakeMedia } from "./fakes"

const offer = { type: "offer", sdp: "v=0\r\nfar\r\n" } as const

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
    await openPeerAudio(media, servers, () => undefined)
    expect(media.asked).toStrictEqual([
      { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
    ])
    expect(peer().configuration).toStrictEqual({ iceServers: servers })
    expect(peer().added).toStrictEqual([[media.microphone.tracks[0], media.microphone]])
  })

  it("passes on a refused microphone", async () => {
    const refused = new DOMException("Permission denied", "NotAllowedError")
    await expect(openPeerAudio(fakeMedia({ refuse: refused }), [], () => undefined)).rejects.toBe(
      refused,
    )
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
    await expect(openPeerAudio(media, [], () => undefined)).rejects.toBe(refused)
    expect(media.microphone.tracks.every((track) => track.stopped)).toBe(true)
  })

  it("answers an offer and makes one, once ICE gathered its candidates", async () => {
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined)
    expect(await audio.describe(offer)).toBe("v=0\r\nlocal\r\n")
    expect(peer().calls).toStrictEqual(["remote offer", "local implicit"])
    const other = await openPeerAudio(fakeMedia(), [], () => undefined)
    expect(await other.describe()).toBe("v=0\r\nlocal\r\n")
    expect(peer().calls).toStrictEqual(["local implicit"])
  })

  it("gives ICE a second at most, and nothing when it is done already", async () => {
    vi.useFakeTimers()
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined)
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
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined)
    peer().gathers = false
    const describing = audio.describe(offer)
    await vi.advanceTimersByTimeAsync(10)
    peer().gather()
    expect(await describing).toBe("v=0\r\nlocal\r\n")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("ignores gathering news that is not the end, and fails without a description", async () => {
    vi.useFakeTimers()
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined)
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
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined)
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
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined)
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
    await openPeerAudio(media, [], () => undefined)
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
    await openPeerAudio(blocked, [], () => undefined)
    expect(() => peer().track([stream])).not.toThrow()
  })

  it("drops the call when the connection fails, not when it merely wobbles", async () => {
    const silent = vi.fn()
    await openPeerAudio(fakeMedia(), [], silent)
    peer().connection("disconnected")
    expect(silent).not.toHaveBeenCalled()
    peer().connection("failed")
    expect(silent).toHaveBeenCalledOnce()
  })

  it("has nothing to clear while it plays no written audio", async () => {
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined)
    expect(() => audio.clear()).not.toThrow()
  })

  it("closes the connection, stops the microphone and silences the speaker", async () => {
    const media = fakeMedia()
    const audio = await openPeerAudio(media, [], () => undefined)
    peer().track([new FakeStream()])
    audio.close()
    expect(peer().calls).toStrictEqual(["close"])
    expect(media.microphone.tracks.every((track) => track.stopped)).toBe(true)
    expect(media.players[0]?.srcObject).toBeNull()
  })

  it("ends its audio streams with the call", async () => {
    const audio = await openPeerAudio(fakeMedia(), [], () => undefined)
    const writer = audio.writable.getWriter()
    await writer.write(new Int16Array(160))
    audio.close()
    expect(await audio.readable.getReader().read()).toStrictEqual({ done: true, value: undefined })
    await expect(writer.write(new Int16Array(160))).rejects.toMatchObject({ name: "AbortError" })
    expect(() => audio.close()).not.toThrow()
  })

  it("closes even after the app stopped reading its stream", async () => {
    const media = fakeMedia()
    const audio = await openPeerAudio(media, [], () => undefined)
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
