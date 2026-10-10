import { describe, expect, it } from "vitest"
import { readRtp, writeRtp } from "../../src/rtp/packet"

const packet = {
  marker: true,
  payloadType: 8,
  sequence: 0xfffe,
  timestamp: 0xfffffff0,
  ssrc: 0xdeadbeef,
  payload: Uint8Array.of(1, 2, 3),
}

const header = (first: number, ...rest: number[]) =>
  Uint8Array.of(first, 0x00, 0x00, 0x01, 0, 0, 0, 2, 0, 0, 0, 3, ...rest)

describe("RTP packets (RFC 3550 §5.1)", () => {
  it("writes a version 2 header and reads it back", () => {
    const data = writeRtp(packet)
    expect([...data]).toStrictEqual([
      0x80, 0x88, 0xff, 0xfe, 0xff, 0xff, 0xff, 0xf0, 0xde, 0xad, 0xbe, 0xef, 1, 2, 3,
    ])
    expect(readRtp(data)).toStrictEqual(packet)
  })

  it("wraps sequence numbers and timestamps instead of overflowing", () => {
    const data = writeRtp({
      ...packet,
      marker: false,
      payloadType: 200,
      sequence: 0x10001,
      timestamp: 2 ** 32 + 5,
    })
    expect(readRtp(data)).toMatchObject({
      marker: false,
      payloadType: 72,
      sequence: 1,
      timestamp: 5,
    })
  })

  it("skips contributing sources, a header extension and padding", () => {
    const csrc = header(0x82, 0, 0, 0, 9, 0, 0, 0, 10, 0xaa)
    expect(readRtp(csrc)?.payload).toStrictEqual(Uint8Array.of(0xaa))
    const extension = header(0x90, 0xbe, 0xde, 0, 1, 1, 2, 3, 4, 0xbb)
    expect(readRtp(extension)?.payload).toStrictEqual(Uint8Array.of(0xbb))
    const padded = header(0xa0, 0xcc, 0, 0, 3)
    expect(readRtp(padded)?.payload).toStrictEqual(Uint8Array.of(0xcc))
    expect(readRtp(header(0x80))?.payload).toStrictEqual(new Uint8Array())
  })

  it("reads a packet from inside a larger buffer", () => {
    const data = writeRtp(packet)
    const buffer = new Uint8Array(data.length + 8)
    buffer.set(data, 4)
    expect(readRtp(buffer.subarray(4, 4 + data.length))).toStrictEqual(packet)
  })

  it.each([
    ["nothing", new Uint8Array()],
    ["a short header", Uint8Array.of(0x80, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0)],
    ["version 1", header(0x40)],
    ["version 3", header(0xc0)],
    ["contributing sources beyond the end", header(0x81, 0, 0)],
    ["an extension header beyond the end", header(0x90, 0xbe)],
    ["an extension beyond the end", header(0x90, 0xbe, 0xde, 0, 2, 1, 2, 3, 4)],
    ["padding of zero", header(0xa0, 0xcc, 0)],
    ["padding beyond the payload", header(0xa0, 0xcc, 9)],
  ])("drops %s", (_, data) => {
    expect(readRtp(data)).toBeUndefined()
  })
})
