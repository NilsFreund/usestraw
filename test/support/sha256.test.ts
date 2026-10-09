import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { toHex } from "../../src/support/hex"
import { sha256 } from "../../src/support/sha256"
import { bytes, samples } from "../helpers"

describe("sha256 (FIPS 180-4)", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    ["a".repeat(1_000_000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"],
  ])("hashes the reference input %#", (input, digest) => {
    expect(toHex(sha256(bytes(input)))).toBe(digest)
  })

  it("matches node:crypto for every length across block boundaries", () => {
    for (const data of samples(300)) {
      expect(toHex(sha256(data))).toBe(createHash("sha256").update(data).digest("hex"))
    }
  })
})
