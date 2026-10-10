import { describe, expect, it } from "vitest"
import { createMedia, sameMedia } from "../../src/core/calls/media"
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
    expect(media.read(bytes(sdp()))).toMatchObject({ codec: "PCMU" })
    expect(media.answer(bytes(sdp({ formats: [18] })))).toBeUndefined()
    expect(media.read(bytes("not sdp"))).toBeUndefined()
    expect(media.read(bytes(sdp({ formats: [18] })))).toBeUndefined()
    expect(media.answer(bytes("not sdp"))).toBeUndefined()
    expect(media.current).toMatchObject({ codec: "PCMU", remote: { host: "192.0.2.20" } })
  })

  it("re-offers with the session's lines in place and the codec in use first", () => {
    const media = createMedia(local, () => 0)
    const video = "m=video 4002 RTP/AVP 31\r\na=rtpmap:31 H261/90000\r\n"
    const offer = sdp({ formats: [8, 0, 101] }).replace("m=audio", `${video}m=audio`)
    expect(mLines(media.answer(bytes(offer)))).toStrictEqual([
      "m=video 0 RTP/AVP 31",
      "m=audio 40000 RTP/AVP 8 101",
    ])
    expect(mLines(media.offer())).toStrictEqual([
      "m=video 0 RTP/AVP 31",
      "m=audio 40000 RTP/AVP 8 0 101",
    ])
    const answer = sdp({ formats: [0], port: 5000 }).replace(
      "m=audio",
      "m=video 0 RTP/AVP 31\r\nm=audio",
    )
    expect(media.read(bytes(answer))).toMatchObject({ codec: "PCMU", remote: { port: 5000 } })
  })

  it("keeps the peer's payload types: tones stay where they are or move to a free number", () => {
    const negotiated = createMedia(local, () => 0)
    negotiated.answer(bytes(sdp({ formats: [0, 100] }).replace("X/8000", "telephone-event/8000")))
    expect(mLines(negotiated.offer())).toStrictEqual(["m=audio 40000 RTP/AVP 0 8 100"])
    const taken = createMedia(local, () => 0)
    taken.answer(
      bytes(
        sdp({ formats: [0, 101, 96] }).replace(
          "a=rtpmap:101 telephone-event/8000",
          "a=rtpmap:101 G726-32/8000",
        ),
      ),
    )
    expect(taken.current).not.toHaveProperty("dtmf")
    expect(mLines(taken.offer())).toStrictEqual(["m=audio 40000 RTP/AVP 0 8 97"])
  })

  it("falls back to 101 for tones when the peer took every dynamic payload type", () => {
    const media = createMedia(local, () => 0)
    const types = [101, ...Array.from({ length: 32 }, (_, index) => 96 + index)]
    const offer = sdp({ formats: [0, ...types] })
      .replace(/X\/8000|telephone-event\/8000/g, "G726-32/8000")
      .replace("a=fmtp:101 0-16\r\n", "")
    media.answer(bytes(offer))
    expect(mLines(media.offer())).toStrictEqual(["m=audio 40000 RTP/AVP 0 8 101"])
  })

  it("sends tones with the payload type the answer chose", () => {
    const media = createMedia(local, () => 0)
    media.offer()
    const answer = sdp({ formats: [0, 100] }).replace("X/8000", "telephone-event/8000")
    expect(media.read(bytes(answer))).toMatchObject({ dtmf: 100 })
  })
})

describe("sameMedia", () => {
  const base = {
    remote: { host: "192.0.2.20", port: 4000 },
    codec: "PCMU",
    payloadType: 0,
    dtmf: 101,
    ptime: 20,
    direction: "sendrecv",
  } as const

  it.each([
    ["host", { remote: { host: "192.0.2.21", port: 4000 } }],
    ["port", { remote: { host: "192.0.2.20", port: 4002 } }],
    ["codec", { codec: "PCMA" }],
    ["payload type", { payloadType: 96 }],
    ["tones", { dtmf: 100 }],
    ["ptime", { ptime: 30 }],
    ["direction", { direction: "recvonly" }],
  ] as const)("tells media apart by %s", (_, change) => {
    expect(sameMedia(base, { ...base, ...change })).toBe(false)
  })

  it("finds equal media equal", () => {
    expect(sameMedia(base, { ...base, remote: { ...base.remote } })).toBe(true)
  })
})
