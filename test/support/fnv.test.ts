import { describe, expect, it } from "vitest"
import { fnv1a } from "../../src/support/fnv"

describe("fnv1a (32 bit)", () => {
  it.each([
    ["", 0x811c9dc5],
    ["a", 0xe40c292c],
    ["foobar", 0xbf9cf968],
    ["😀", 0xcb31c4b8],
  ])("hashes %j to the reference value", (text, expected) => {
    expect(fnv1a(text)).toBe(expected)
  })
})
