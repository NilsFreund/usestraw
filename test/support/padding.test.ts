import { describe, expect, it } from "vitest"
import { pad } from "../../src/support/padding"

function bytes(view: DataView): number[] {
  return Array.from(new Uint8Array(view.buffer))
}

describe("pad (Merkle-Damgård)", () => {
  it.each([
    [0, 64, 64],
    [55, 64, 64],
    [56, 64, 128],
    [64, 64, 128],
    [111, 128, 128],
    [112, 128, 256],
  ] as const)("pads %d bytes to %d-byte blocks as %d bytes", (length, block, size) => {
    expect(pad(new Uint8Array(length), block, false).byteLength).toBe(size)
  })

  it("appends the 0x80 marker right after the message", () => {
    const padded = bytes(pad(Uint8Array.of(1, 2, 3), 64, false))
    expect(padded.slice(0, 5)).toEqual([1, 2, 3, 0x80, 0])
  })

  it("ends with the bit length in big-endian order", () => {
    expect(bytes(pad(new Uint8Array(3), 64, false)).slice(-8)).toEqual([0, 0, 0, 0, 0, 0, 0, 24])
  })

  it("ends with the bit length in little-endian order for MD5", () => {
    expect(bytes(pad(new Uint8Array(300), 64, true)).slice(-8)).toEqual([96, 9, 0, 0, 0, 0, 0, 0])
  })
})
