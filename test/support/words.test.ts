import { describe, expect, it } from "vitest"
import { words32, words64 } from "../../src/support/words"

describe("words32", () => {
  it("reads whitespace-separated hex into big-endian 32-bit words", () => {
    const view = words32(`
      01020304
      ffffffff
    `)
    expect(Array.from(new Uint8Array(view.buffer))).toEqual([1, 2, 3, 4, 255, 255, 255, 255])
  })
})

describe("words64", () => {
  it("reads whitespace-separated hex into big-endian 64-bit words", () => {
    const view = words64("0102030405060708 ffffffffffffffff")
    expect(view.getBigUint64(0)).toBe(0x0102030405060708n)
    expect(view.getBigUint64(8)).toBe(0xffffffffffffffffn)
  })
})
