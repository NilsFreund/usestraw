import { describe, expect, it } from "vitest"
import { answerOffer, createOffer, isPlayable, readAnswer } from "../../src/sdp/negotiate"
import { parseSdp } from "../../src/sdp/parse"
import type { SessionDescription } from "../../src/sdp/types"
import { bytes, sdp } from "../helpers"
import { asterisk, freeswitch, ims, rfc4317, rtpengine, twoAudio, webrtc } from "./samples"

const local = { host: "192.0.2.10", port: 40_000 }
const local6 = { host: "2001:db8::10", port: 40_000 }

function parsed(text: string): SessionDescription {
  const description = parseSdp(bytes(text))
  if (!description) throw new Error("Unreadable SDP")
  return description
}

describe("createOffer (RFC 3264 §5)", () => {
  it("offers PCMU and PCMA at 20 ms, and no tones until Straw can hear them", () => {
    expect(createOffer(local)).toStrictEqual({
      kind: "audio",
      port: 40_000,
      protocol: "RTP/AVP",
      formats: ["0", "8"],
      rtpmap: new Map([
        [0, { name: "PCMU", rate: 8000 }],
        [8, { name: "PCMA", rate: 8000 }],
      ]),
      ptime: 20,
      direction: "sendrecv",
    })
  })

  it("puts the codec in use first", () => {
    const offer = createOffer(local, { prefer: "PCMA" })
    expect(offer.formats).toStrictEqual(["8", "0"])
    expect([...offer.rtpmap.keys()]).toStrictEqual([8, 0])
  })
})

describe("answerOffer (RFC 3264 §6)", () => {
  it("answers FreeSWITCH with its first codec we can play, and leaves its tones out", () => {
    const answer = answerOffer(parsed(freeswitch), local)
    expect(answer?.index).toBe(0)
    expect(answer?.call).toStrictEqual({
      remote: { host: "203.0.113.5", port: 23456 },
      codec: "PCMA",
      payloadType: 8,
      ptime: 20,
      direction: "sendrecv",
    })
    expect(answer?.media).toStrictEqual([
      {
        kind: "audio",
        port: 40_000,
        protocol: "RTP/AVP",
        formats: ["8"],
        rtpmap: new Map([[8, { name: "PCMA", rate: 8000 }]]),
        ptime: 20,
        direction: "sendrecv",
      },
    ])
  })

  it("skips codecs it cannot play and sends at the offerer's ptime", () => {
    expect(answerOffer(parsed(asterisk), local)?.call).toMatchObject({
      codec: "PCMU",
      payloadType: 0,
      ptime: 30,
    })
  })

  it("keeps the codec it already uses when the offer still has it", () => {
    expect(answerOffer(parsed(freeswitch), local, { prefer: "PCMU" })?.call.codec).toBe("PCMU")
    expect(answerOffer(parsed(sdp({ formats: [8] })), local, { prefer: "PCMU" })?.call.codec).toBe(
      "PCMA",
    )
  })

  it("answers RFC 4317 §2.1 by accepting the audio and refusing the video with a bare port 0 line", () => {
    const answer = answerOffer(parsed(rfc4317), local)
    expect(answer?.call).toMatchObject({
      remote: { host: "198.51.100.1", port: 49170 },
      codec: "PCMU",
    })
    expect(answer?.media[1]).toStrictEqual({
      kind: "video",
      port: 0,
      protocol: "RTP/AVP",
      formats: ["31"],
      rtpmap: new Map(),
    })
  })

  it("does not echo the attributes of a line it refuses", () => {
    const text = sdp().replace(
      "m=audio",
      "m=video 4002 RTP/AVP 31\r\na=sendonly\r\na=ptime:40\r\nm=audio",
    )
    expect(answerOffer(parsed(text), local)?.media[0]).toStrictEqual({
      kind: "video",
      port: 0,
      protocol: "RTP/AVP",
      formats: ["31"],
      rtpmap: new Map(),
    })
  })

  it("plays only the first of two playable audio lines", () => {
    const text = sdp({ formats: [0] }).replace(
      "m=audio 4000 RTP/AVP 0\r\n",
      "m=audio 4000 RTP/AVP 0\r\nm=audio 4002 RTP/AVP 0\r\n",
    )
    const answer = answerOffer(parsed(text), local)
    expect(answer?.media.map((line) => line.port)).toStrictEqual([40_000, 0])
    expect(answer?.call.remote.port).toBe(4000)
  })

  it("plays only the first audio line it can and refuses the others (RFC 4317 §2.6)", () => {
    const offer = parsed(twoAudio)
    const answer = answerOffer(offer, local)
    expect(answer?.media.map((line) => line.port)).toStrictEqual([40_000, 0])
    expect(answer?.call.remote.port).toBe(49170)
    const second = answerOffer({ ...offer, media: [...offer.media].reverse() }, local)
    expect(second?.media.map((line) => line.port)).toStrictEqual([0, 40_000])
    expect(second?.index).toBe(1)
  })

  it("answers an IPv6 offer from rtpengine with an IPv6 address", () => {
    const answer = answerOffer(parsed(rtpengine), local6)
    expect(answer?.call).toMatchObject({ remote: { host: "2001:db8::5", port: 40002 } })
    expect(answer?.media[0]?.formats).toStrictEqual(["0"])
  })

  it.each([
    ["an IPv6 offer for our IPv4 address", rtpengine, local],
    ["an IPv4 offer for our IPv6 address", sdp(), local6],
  ])("finds no media path in %s", (_, text, ours) => {
    expect(answerOffer(parsed(text), ours)).toBeUndefined()
  })

  it("echoes RTP/AVPF and plays it like RTP/AVP", () => {
    const answer = answerOffer(parsed(sdp().replace("RTP/AVP", "RTP/AVPF")), local)
    expect(answer?.media[0]?.protocol).toBe("RTP/AVPF")
  })

  it.each([
    ["AMR only from a mobile network", ims],
    ["WebRTC with DTLS-SRTP", webrtc],
    ["G.729 only", sdp({ formats: [18] })],
    ["a stream already refused", sdp({ port: 0 })],
    ["no connection address", sdp().replace("c=IN IP4 192.0.2.20\r\n", "")],
    [
      "a host name for the connection",
      sdp().replace("c=IN IP4 192.0.2.20", "c=IN IP4 media.example.com"),
    ],
    [
      "a connection of the wrong family",
      sdp().replace("c=IN IP4 192.0.2.20", "c=IN IP6 192.0.2.20"),
    ],
    ["a multicast connection", sdp().replace("c=IN IP4 192.0.2.20", "c=IN IP4 233.252.0.1/127")],
    ["a broadcast connection", sdp().replace("c=IN IP4 192.0.2.20", "c=IN IP4 255.255.255.255")],
    [
      "static types renamed",
      sdp().replace("PCMU/8000", "G722/8000").replace("PCMA/8000", "PCMA/16000"),
    ],
    ["stereo G.711", sdp({ formats: [0] }).replace("PCMU/8000", "PCMU/8000/2")],
    [
      "payload types out of range",
      sdp({ formats: [0] })
        .replace("RTP/AVP 0", "RTP/AVP 128 00 +0 0x8 8.0")
        .replace("a=rtpmap:0 PCMU/8000", "a=rtpmap:128 PCMU/8000"),
    ],
    ["G.711 on a video line", sdp({ formats: [0] }).replace("m=audio", "m=video")],
  ])("finds nothing to play in %s", (_, text) => {
    expect(answerOffer(parsed(text), local)).toBeUndefined()
    expect(isPlayable(bytes(text))).toBe(false)
  })

  it("plays G.711 under dynamic payload types and any case", () => {
    const text = sdp({ formats: [96] }).replace("X/8000", "pcma/8000")
    expect(answerOffer(parsed(text), local)?.call).toMatchObject({ codec: "PCMA", payloadType: 96 })
    expect(isPlayable(bytes(text))).toBe(true)
  })

  it("treats unreadable SDP as unplayable", () => {
    expect(isPlayable(bytes("v=0\r\n"))).toBe(false)
  })

  it.each([
    ["sendrecv", "sendrecv"],
    ["sendonly", "recvonly"],
    ["recvonly", "sendonly"],
    ["inactive", "inactive"],
  ])("answers an offer that is %s with %s (RFC 3264 §6.1)", (offered, answered) => {
    const answer = answerOffer(parsed(sdp({ direction: offered })), local)
    expect(answer?.call.direction).toBe(answered)
    expect(answer?.media[0]?.direction).toBe(answered)
  })

  it("takes a session-level direction when the media line has none", () => {
    const text = sdp().replace("t=0 0\r\n", "t=0 0\r\na=sendonly\r\n")
    expect(answerOffer(parsed(text), local)?.call.direction).toBe("recvonly")
  })

  it.each(["0.0.0.0", "000.000.000.000"])(
    "does not send to an old-style hold at %s (RFC 3264 §8.4)",
    (host) => {
      expect(answerOffer(parsed(sdp({ host })), local)?.call.direction).toBe("recvonly")
      const recvonly = sdp({ host, direction: "recvonly" })
      expect(answerOffer(parsed(recvonly), local)?.call.direction).toBe("inactive")
      const sendonly = sdp({ host, direction: "sendonly" })
      expect(answerOffer(parsed(sendonly), local)?.call.direction).toBe("recvonly")
    },
  )

  it.each(["::", "::0", "0:0:0:0:0:0:0:0"])("does not send to an IPv6 hold at %s", (host) => {
    const text = sdp().replace("c=IN IP4 192.0.2.20", `c=IN IP6 ${host}`)
    expect(answerOffer(parsed(text), local6)?.call.direction).toBe("recvonly")
  })

  it.each([
    [10, 10],
    [120, 120],
    [9, 20],
    [121, 20],
  ])("sends at a ptime of %i ms as %i ms", (ptime, expected) => {
    const text = sdp({ extra: [`a=ptime:${ptime}`] })
    expect(answerOffer(parsed(text), local)?.call.ptime).toBe(expected)
  })
})

describe("readAnswer (RFC 3264 §6.1)", () => {
  it("sends with the payload type and address of the answer", () => {
    expect(readAnswer(parsed(sdp({ formats: [8, 101], port: 5000 })), 0, local)).toStrictEqual({
      remote: { host: "192.0.2.20", port: 5000 },
      codec: "PCMA",
      payloadType: 8,
      ptime: 20,
      direction: "sendrecv",
    })
  })

  it("reads the line at the index of our audio line", () => {
    const answer = parsed(sdp().replace("m=audio", "m=video 0 RTP/AVP 31\r\nm=audio"))
    expect(readAnswer(answer, 1, local)?.codec).toBe("PCMU")
    expect(readAnswer(answer, 0, local)).toBeUndefined()
    expect(readAnswer(answer, 2, local)).toBeUndefined()
  })

  it("turns the answer's direction around", () => {
    expect(readAnswer(parsed(sdp({ direction: "recvonly" })), 0, local)?.direction).toBe("sendonly")
    expect(readAnswer(parsed(sdp({ direction: "sendonly" })), 0, local)?.direction).toBe("recvonly")
  })

  it("finds nothing when the answer refused or changed our line", () => {
    expect(readAnswer(parsed(sdp({ port: 0 })), 0, local)).toBeUndefined()
    expect(readAnswer(parsed(sdp({ formats: [18] })), 0, local)).toBeUndefined()
    expect(readAnswer(parsed(sdp()), 0, local6)).toBeUndefined()
  })
})
