import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { toHex } from "../../src/support/hex"
import { sha512_256 } from "../../src/support/sha512-256"
import { bytes, samples } from "../helpers"

describe("sha512_256 (FIPS 180-4 SHA-512/256)", () => {
  it.each([
    ["", "c672b8d1ef56ed28ab87c3622c5114069bdd3ad7b8f9737498d0c01ecef0967a"],
    ["abc", "53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23"],
    [
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
      "3928e184fb8690f840da3988121d31be65cb9d3ef83ee6146feac861e19b563a",
    ],
  ])("hashes the reference input %#", (input, digest) => {
    expect(toHex(sha512_256(bytes(input)))).toBe(digest)
  })

  it("matches node:crypto for every length across block boundaries", () => {
    for (const data of samples(300)) {
      expect(toHex(sha512_256(data))).toBe(createHash("sha512-256").update(data).digest("hex"))
    }
  })
})
