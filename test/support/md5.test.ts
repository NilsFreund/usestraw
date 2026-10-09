import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { toHex } from "../../src/support/hex"
import { md5 } from "../../src/support/md5"
import { bytes, samples } from "../helpers"

describe("md5 (RFC 1321)", () => {
  it.each([
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      "d174ab98d277d9f5a5611c2c9f419d9f",
    ],
    ["1234567890".repeat(8), "57edf4a22be3c955ac49da2e2107b67a"],
  ])("hashes the reference input %#", (input, digest) => {
    expect(toHex(md5(bytes(input)))).toBe(digest)
  })

  it("matches node:crypto for every length across block boundaries", () => {
    for (const data of samples(300)) {
      expect(toHex(md5(data))).toBe(createHash("md5").update(data).digest("hex"))
    }
  })
})
