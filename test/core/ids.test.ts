import { describe, expect, it } from "vitest"
import { createBranch, createCallId, createTag, randomToken } from "../../src/core/ids"
import { createRandom } from "../../src/simulation/random"

describe("randomToken", () => {
  it("uses lowercase letters and digits of the requested length", () => {
    expect(randomToken(createRandom(1), 64)).toMatch(/^[a-z0-9]{64}$/)
  })

  it("is deterministic for the same random source", () => {
    expect(randomToken(createRandom(9), 12)).toBe(randomToken(createRandom(9), 12))
  })

  it("covers the whole alphabet", () => {
    const token = randomToken(createRandom(3), 5000)
    expect(new Set(token).size).toBe(36)
  })

  it("maps the edges of the random range to the first and last character", () => {
    expect(randomToken(() => 0, 1)).toBe("a")
    expect(randomToken(() => 0.999_999, 1)).toBe("9")
  })

  it("keeps the full length even if a random source returns 1", () => {
    expect(randomToken(() => 1, 4)).toBe("9999")
  })
})

describe("identifiers", () => {
  it("prefixes branches with the RFC 3261 magic cookie", () => {
    expect(createBranch(createRandom(1))).toMatch(/^z9hG4bK[a-z0-9]{16}$/)
  })

  it("creates tags and Call-IDs of fixed length", () => {
    expect(createTag(createRandom(1))).toMatch(/^[a-z0-9]{10}$/)
    expect(createCallId(createRandom(1))).toMatch(/^[a-z0-9]{20}$/)
  })
})
