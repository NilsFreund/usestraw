import { describe, expect, it } from "vitest"
import { atMost } from "../../src/message/limits"
import { ParseError } from "../../src/message/syntax"

describe("atMost", () => {
  it("passes lists up to the limit through", () => {
    const items = [1, 2, 3]
    expect(atMost(items, 3, "things")).toBe(items)
  })

  it("rejects lists above the limit", () => {
    expect(() => atMost([1, 2, 3, 4], 3, "things")).toThrow(
      new ParseError("Too many things (limit 3)"),
    )
  })
})
