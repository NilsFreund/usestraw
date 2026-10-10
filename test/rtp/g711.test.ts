import { describe, expect, it } from "vitest"
import { decodeG711, encodeG711 } from "../../src/rtp/g711"

const codes = Uint8Array.from({ length: 256 }, (_, code) => code)
const linear = Int16Array.from({ length: 65_536 }, (_, index) => index - 32_768)

describe("G.711 (ITU-T G.711)", () => {
  it("decodes μ-law codes to the reference values", () => {
    const decoded = decodeG711("PCMU", Uint8Array.of(0xff, 0x7f, 0x80, 0x00, 0xef, 0x6f))
    expect([...decoded]).toStrictEqual([0, 0, 32_124, -32_124, 132, -132])
  })

  it("decodes A-law codes to the reference values", () => {
    const decoded = decodeG711("PCMA", Uint8Array.of(0xd5, 0x55, 0xaa, 0x2a, 0xd4, 0x54))
    expect([...decoded]).toStrictEqual([8, -8, 32_256, -32_256, 24, -24])
  })

  it.each([
    ["PCMU", [0, 1, -1, 32_767, -32_768, 100, -100], [0xff, 0xff, 0x7f, 0x80, 0x00, 0xf2, 0x73]],
    ["PCMU", [-31_612, -31_611, -132, -133], [0x01, 0x01, 0x6f, 0x6f]],
    ["PCMA", [0, 1, -1, 32_767, -32_768, 100, -100], [0xd5, 0xd5, 0x55, 0xaa, 0x2a, 0xd3, 0x53]],
  ] as const)("encodes %s at the edges and around zero", (codec, samples, expected) => {
    expect([...encodeG711(codec, Int16Array.from(samples))]).toStrictEqual(expected)
  })

  it.each(["PCMU", "PCMA"] as const)(
    "encodes every %s value back to the code it came from",
    (codec) => {
      const values = decodeG711(codec, codes)
      const again = encodeG711(codec, values)
      const decoded = decodeG711(codec, again)
      expect(decoded).toStrictEqual(values)
      const exact = codec === "PCMU" ? codes.filter((code) => code !== 0x7f) : codes
      expect([...again].filter((_, code) => exact.includes(code))).toStrictEqual([...exact])
    },
  )

  it.each(["PCMU", "PCMA"] as const)("keeps every 16-bit sample within one step of %s", (codec) => {
    const decoded = decodeG711(codec, encodeG711(codec, linear))
    let worst = 0
    for (let index = 0; index < linear.length; index++) {
      const value = linear[index] ?? 0
      const error = Math.abs((decoded[index] ?? 0) - value) / Math.max(256, Math.abs(value))
      worst = Math.max(worst, error)
    }
    expect(worst).toBeLessThan(0.07)
    expect(
      decoded.every((value, index) => Math.sign(value) * Math.sign(linear[index] ?? 0) >= 0),
    ).toBe(true)
  })
})
