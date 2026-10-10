import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { toHex } from "../../src/support/hex"
import { hmacSha256 } from "../../src/support/hmac"
import { bytes, samples } from "../helpers"

const repeat = (byte: number, length: number) => new Uint8Array(length).fill(byte)

describe("hmacSha256 (RFC 2104)", () => {
  it.each([
    [
      repeat(0x0b, 20),
      bytes("Hi There"),
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    ],
    [
      bytes("Jefe"),
      bytes("what do ya want for nothing?"),
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    ],
    [
      repeat(0xaa, 20),
      repeat(0xdd, 50),
      "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe",
    ],
    [
      repeat(0xaa, 131),
      bytes("Test Using Larger Than Block-Size Key - Hash Key First"),
      "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
    ],
  ])("matches RFC 4231 test case %#", (key, data, mac) => {
    expect(toHex(hmacSha256(key, data))).toBe(mac)
  })

  it("matches node:crypto for keys around the block size", () => {
    for (const key of samples(130)) {
      const data = key.subarray(0, 40)
      expect(toHex(hmacSha256(key, data))).toBe(
        createHmac("sha256", key).update(data).digest("hex"),
      )
    }
  })
})
