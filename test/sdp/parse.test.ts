import { describe, expect, it } from "vitest"
import { parseSdp } from "../../src/sdp/parse"
import { bytes } from "../helpers"
import { asterisk, freeswitch, ims, rfc4317, rtpengine, webrtc } from "./samples"

const parse = (text: string) => parseSdp(bytes(text))
const minimal = ["v=0", "o=- 1 1 IN IP4 192.0.2.1", "s=-", "t=0 0"]
const described = (...extra: string[]) => [...minimal, ...extra].join("\r\n")

describe("parseSdp (RFC 8866)", () => {
  it("reads a FreeSWITCH offer", () => {
    expect(parse(freeswitch)).toStrictEqual({
      origin: "FreeSWITCH 1728540000 1728540001 IN IP4 203.0.113.5",
      connection: { family: "IP4", address: "203.0.113.5" },
      media: [
        {
          kind: "audio",
          port: 23456,
          protocol: "RTP/AVP",
          formats: ["8", "0", "101"],
          rtpmap: new Map([
            [8, { name: "PCMA", rate: 8000 }],
            [0, { name: "PCMU", rate: 8000 }],
            [101, { name: "telephone-event", rate: 8000 }],
          ]),
          fmtp: new Map([[101, "0-16"]]),
          ptime: 20,
          direction: "sendrecv",
        },
      ],
    })
  })

  it("reads channels, several lines, media-level connections and IPv6", () => {
    expect(parse(asterisk)?.media[0]?.rtpmap.get(111)).toStrictEqual({
      name: "opus",
      rate: 48000,
      channels: 2,
    })
    expect(parse(rfc4317)?.media.map((line) => [line.kind, line.port])).toStrictEqual([
      ["audio", 49170],
      ["video", 51372],
    ])
    expect(parse(rtpengine)).toMatchObject({
      media: [{ connection: { family: "IP6", address: "2001:db8::5" } }],
    })
    expect(parse(rtpengine)).not.toHaveProperty("connection")
    expect(parse(webrtc)?.media[0]).toMatchObject({
      protocol: "UDP/TLS/RTP/SAVPF",
      connection: { family: "IP4", address: "0.0.0.0" },
    })
    expect(parse(ims)?.media[0]?.formats).toStrictEqual(["104", "102", "105", "100"])
  })

  it("keeps the session-level direction apart from the media-level one", () => {
    const text = described(
      "a=sendonly",
      "c=IN IP4 192.0.2.1",
      "m=audio 4000 RTP/AVP 0",
      "a=inactive",
    )
    expect(parse(text)).toMatchObject({ direction: "sendonly", media: [{ direction: "inactive" }] })
  })

  it("accepts bare line feeds, a port count and a multicast TTL", () => {
    const text = described("c=IN IP4 233.252.0.1/127", "m=audio 4000/2 RTP/AVP 0").replaceAll(
      "\r\n",
      "\n",
    )
    expect(parse(text)).toMatchObject({
      connection: { family: "IP4", address: "233.252.0.1" },
      media: [{ port: 4000 }],
    })
  })

  it("skips lines and attributes it does not need or cannot read", () => {
    const text = described(
      "garbage",
      "b=AS:64",
      "a=rtpmap:0 PCMU/8000",
      "a=sendrecv-ish",
      "c=XX IP4 192.0.2.1",
      "c=XIN IP4 192.0.2.1",
      "aXsendonly",
      "m=audio 4000 RTP/AVP 0 8",
      "o=- 9 9 IN IP4 192.0.2.9",
      "a=rtpmap:8 PCMA",
      "a=rtpmap:x PCMA/8000",
      "a=rtpmap:8 PCMA/8000x",
      "a=fmtp:101",
      "a=fmtp:x 0-16",
      "a=ptime:twenty",
      "a=ptime:1000",
      "a=rtpmap",
      "c=IN IP4",
      "x",
    )
    expect(parse(text)).toStrictEqual({
      origin: "- 1 1 IN IP4 192.0.2.1",
      media: [
        {
          kind: "audio",
          port: 4000,
          protocol: "RTP/AVP",
          formats: ["0", "8"],
          rtpmap: new Map(),
          fmtp: new Map(),
        },
      ],
    })
  })

  it.each([
    ["no version line", ["o=- 1 1 IN IP4 192.0.2.1", "m=audio 4000 RTP/AVP 0"].join("\r\n")],
    ["another version", "v=1\r\no=- 1 1 IN IP4 192.0.2.1\r\nm=audio 4000 RTP/AVP 0"],
    ["no origin", "v=0\r\nm=audio 4000 RTP/AVP 0"],
    ["no media", described("c=IN IP4 192.0.2.1")],
    ["a broken media line", described("m=audio RTP/AVP 0")],
    ["a media line without formats", described("m=audio 4000 RTP/AVP")],
    ["a port above 65535", described("m=audio 70000 RTP/AVP 0")],
    [
      "more than 16 media lines",
      described(...Array.from({ length: 17 }, () => "m=audio 4000 RTP/AVP 0")),
    ],
    ["nothing at all", ""],
    ["a token longer than 32 characters", described(`m=audio 4000 RTP/AVP ${"9".repeat(33)}`)],
    ["a media line with a stray character", described("m=audio 4000 RTP/AVP 0 \u00e9")],
  ])("refuses a description with %s", (_, text) => {
    expect(parse(text)).toBeUndefined()
  })

  it("refuses bytes that are not UTF-8", () => {
    const [head = "", tail = ""] = described("m=audio 4000 RTP/AVP 0").split("s=-")
    const broken = new Uint8Array([...bytes(`${head}s=`), 0xff, 0xfe, ...bytes(tail)])
    expect(parseSdp(broken)).toBeUndefined()
    expect(parseSdp(bytes(`${head}s=-${tail}`))).toBeDefined()
  })

  it("reads 16 media lines", () => {
    const text = described(...Array.from({ length: 16 }, () => "m=audio 4000 RTP/AVP 0"))
    expect(parse(text)?.media).toHaveLength(16)
  })
})
