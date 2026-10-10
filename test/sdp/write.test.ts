import { describe, expect, it } from "vitest"
import { createOffer } from "../../src/sdp/negotiate"
import { parseSdp } from "../../src/sdp/parse"
import { writeMedia, writeSdp } from "../../src/sdp/write"

const text = (data: Uint8Array) => new TextDecoder().decode(data)

describe("writeSdp (RFC 8866)", () => {
  it("writes our offer so it reads back the same", () => {
    const offer = createOffer({ host: "192.0.2.10", port: 40_000 })
    const data = writeSdp(
      { id: "42", version: 3, host: "192.0.2.10" },
      writeMedia("192.0.2.10", [offer]),
    )
    expect(text(data)).toBe(
      [
        "v=0",
        "o=- 42 3 IN IP4 192.0.2.10",
        "s=-",
        "c=IN IP4 192.0.2.10",
        "t=0 0",
        "m=audio 40000 RTP/AVP 0 8 101",
        "a=rtpmap:0 PCMU/8000",
        "a=rtpmap:8 PCMA/8000",
        "a=rtpmap:101 telephone-event/8000",
        "a=fmtp:101 0-16",
        "a=ptime:20",
        "a=sendrecv",
        "",
      ].join("\r\n"),
    )
    expect(parseSdp(data)?.media).toStrictEqual([offer])
  })

  it("writes IPv6 without brackets, channels, and lines without optional attributes", () => {
    const line = {
      kind: "video",
      port: 0,
      protocol: "RTP/AVP",
      formats: ["31"],
      rtpmap: new Map([[31, { name: "L16", rate: 44_100, channels: 2 }]]),
      fmtp: new Map(),
    }
    const data = writeSdp(
      { id: "1", version: 1, host: "[2001:db8::1]" },
      writeMedia("[2001:db8::1]", [line]),
    )
    expect(text(data)).toBe(
      [
        "v=0",
        "o=- 1 1 IN IP6 2001:db8::1",
        "s=-",
        "c=IN IP6 2001:db8::1",
        "t=0 0",
        "m=video 0 RTP/AVP 31",
        "a=rtpmap:31 L16/44100/2",
        "",
      ].join("\r\n"),
    )
  })
})
