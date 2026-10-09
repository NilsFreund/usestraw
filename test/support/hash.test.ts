import { describe, expect, it } from "vitest"
import { hash } from "../../src/support/hash"

describe("hash (FNV-1a, 32 bit)", () => {
  it.each([
    ["", 0x811c9dc5],
    ["a", 0xe40c292c],
    ["foobar", 0xbf9cf968],
    ["😀", 0xcb31c4b8],
  ])("hashes %j to the reference value", (text, expected) => {
    expect(hash(text)).toBe(expected)
  })
})
