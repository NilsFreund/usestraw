import { describe, expect, it } from "vitest"
import {
  createAppMedia,
  createMedia,
  sameMedia,
  sameShown,
  sdpOf,
} from "../../src/core/calls/media"
import { bytes, sdp } from "../helpers"

const local = { host: "192.0.2.10", port: 40_000 }
const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data)
const origin = (data: Uint8Array | undefined) => /^o=.*$/m.exec(text(data))?.[0]
const mLines = (data: Uint8Array | undefined) => text(data).match(/^m=.*$/gm)

describe("createMedia (RFC 3264 §8)", () => {
  it("keeps its session id and only counts up the version when its description changes", () => {
    const media = createMedia(local, () => 0.5)
    const offer = media.offer()
    expect(origin(offer)).toBe("o=- 1073741824 1 IN IP4 192.0.2.10")
    expect(origin(media.offer())).toBe("o=- 1073741824 1 IN IP4 192.0.2.10")
    const answer = media.answer(bytes(sdp()))
    expect(origin(answer)).toBe("o=- 1073741824 2 IN IP4 192.0.2.10")
    expect(media.answer(bytes(sdp()))).toStrictEqual(answer)
    expect(origin(media.answer(bytes(sdp({ direction: "sendonly" }))))).toBe(
      "o=- 1073741824 3 IN IP4 192.0.2.10",
    )
  })

  it("keeps what it had when an offer or answer cannot be used", () => {
    const media = createMedia(local, () => 0)
    media.offer()
    expect(media.read(bytes(sdp()))).toBe(true)
    expect(media.shown("answer").media).toMatchObject({ codec: "PCMU" })
    expect(media.answer(bytes(sdp({ formats: [18] })))).toBeUndefined()
    expect(media.read(bytes("not sdp"))).toBe(false)
    expect(media.read(bytes(sdp({ formats: [18] })))).toBe(false)
    expect(media.answer(bytes("not sdp"))).toBeUndefined()
    expect(media.shown("answer").media).toMatchObject({
      codec: "PCMU",
      remote: { host: "192.0.2.20" },
    })
  })

  it("re-offers with the session's lines in place and the codec in use first", () => {
    const media = createMedia(local, () => 0)
    const video = "m=video 4002 RTP/AVP 31\r\na=rtpmap:31 H261/90000\r\n"
    const offer = sdp({ formats: [8, 0, 101] }).replace("m=audio", `${video}m=audio`)
    expect(mLines(media.answer(bytes(offer)))).toStrictEqual([
      "m=video 0 RTP/AVP 31",
      "m=audio 40000 RTP/AVP 8",
    ])
    expect(mLines(media.offer())).toStrictEqual([
      "m=video 0 RTP/AVP 31",
      "m=audio 40000 RTP/AVP 8 0",
    ])
    const answer = sdp({ formats: [0], port: 5000 }).replace(
      "m=audio",
      "m=video 0 RTP/AVP 31\r\nm=audio",
    )
    expect(media.read(bytes(answer))).toBe(true)
    expect(media.shown("answer").media).toMatchObject({ codec: "PCMU", remote: { port: 5000 } })
  })

  it("neither offers nor answers tones", () => {
    const media = createMedia(local, () => 0)
    const tones = sdp({ formats: [0, 101] })
    expect(mLines(media.answer(bytes(tones)))).toStrictEqual(["m=audio 40000 RTP/AVP 0"])
    expect(text(media.offer())).not.toContain("telephone-event")
  })
})

describe("sameMedia", () => {
  const base = {
    remote: { host: "192.0.2.20", port: 4000 },
    codec: "PCMU",
    payloadType: 0,
    ptime: 20,
    direction: "sendrecv",
  } as const

  it.each([
    ["host", { remote: { host: "192.0.2.21", port: 4000 } }],
    ["port", { remote: { host: "192.0.2.20", port: 4002 } }],
    ["codec", { codec: "PCMA" }],
    ["payload type", { payloadType: 96 }],
    ["ptime", { ptime: 30 }],
    ["direction", { direction: "recvonly" }],
  ] as const)("tells media apart by %s", (_, change) => {
    expect(sameMedia(base, { ...base, ...change })).toBe(false)
  })

  it("finds equal media equal", () => {
    expect(sameMedia(base, { ...base, remote: { ...base.remote } })).toBe(true)
  })
})

describe("createAppMedia", () => {
  const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data)
  const remote = (version: number) => sdp({ version })

  it("shows nothing before it heard the far end, and offers the app's SDP as it is", () => {
    const media = createAppMedia("v=0\r\nours")
    expect(media.shown("answer")).toEqual({})
    expect(text(media.offer())).toBe("v=0\r\nours")
  })

  it("answers the first offer and the very same one again, and leaves any other to the app", () => {
    const media = createAppMedia("v=0\r\nours")
    expect(text(media.answer(bytes(remote(1))))).toBe("v=0\r\nours")
    expect(text(media.answer(bytes(remote(1))))).toBe("v=0\r\nours")
    expect(media.answer(bytes(remote(2)))).toBeUndefined()
    expect(media.answer(bytes(`${remote(1)}a=extra\r\n`))).toBeUndefined()
    expect(text(media.use?.("v=0\r\nnext", bytes(remote(2))))).toBe("v=0\r\nnext")
    expect(text(media.answer(bytes(remote(2))))).toBe("v=0\r\nnext")
  })

  it("shows the answer it read in the role the call asks for", () => {
    const media = createAppMedia("v=0\r\nours")
    expect(media.read(bytes(remote(1)))).toBe(true)
    expect(media.shown("pranswer")).toEqual({ description: { type: "pranswer", sdp: remote(1) } })
    expect(media.shown("answer")).toEqual({ description: { type: "answer", sdp: remote(1) } })
  })

  it("leaves offers after its own to the app, and reads only SDP", () => {
    const media = createAppMedia("v=0\r\nours")
    expect(media.read(new Uint8Array())).toBe(false)
    expect(media.answer(bytes(remote(1)))).toBeUndefined()
    const offering = createAppMedia("v=0\r\nours")
    expect(text(offering.use?.("v=0\r\noffer", new Uint8Array()))).toBe("v=0\r\noffer")
    expect(offering.answer(bytes(remote(1)))).toBeUndefined()
  })
})

describe("sdpOf", () => {
  it("takes UTF-8 SDP and nothing else", () => {
    expect(sdpOf(bytes("v=0\r\no=- 1 1 IN IP4 192.0.2.1\r\n"))).toBe(
      "v=0\r\no=- 1 1 IN IP4 192.0.2.1\r\n",
    )
    expect(sdpOf(bytes("v=0\nx"))).toBe("v=0\nx")
    expect(sdpOf(new Uint8Array())).toBeUndefined()
    expect(sdpOf(new Uint8Array([0xff]))).toBeUndefined()
    expect(sdpOf(bytes("hello"))).toBeUndefined()
    expect(sdpOf(bytes("v=0\r\n\0"))).toBeUndefined()
  })
})

describe("sameShown", () => {
  it("compares the agreed media, and nothing else", () => {
    const rtp = createMedia({ host: "192.0.2.10", port: 40_000 }, () => 0)
    expect(rtp.shown("answer")).toEqual({})
    rtp.answer(bytes(sdp()))
    expect(sameShown(rtp.shown("answer"), rtp.shown("answer"))).toBe(true)
    expect(sameShown({}, rtp.shown("answer"))).toBe(false)
    expect(sameShown({}, {})).toBe(true)
  })
})
