import { describe, expect, it } from "vitest"
import { formatParams, isParams, parseParams } from "../../../src/message/fields/params"
import { ParseError } from "../../../src/message/syntax"

describe("parseParams", () => {
  it("parses values, flags and quoted strings with lowercase names", () => {
    expect(parseParams(' ; Tag = abc ;lr; x="a;b"')).toEqual(
      new Map([
        ["tag", "abc"],
        ["lr", null],
        ["x", '"a;b"'],
      ]),
    )
  })

  it("returns an empty map for empty input", () => {
    expect(parseParams("  ")).toEqual(new Map())
  })

  it("keeps escaped quotes and line separators inside quoted values", () => {
    expect(parseParams(';x="a\\"b";y="\u2028"')).toEqual(
      new Map([
        ["x", '"a\\"b"'],
        ["y", '"\u2028"'],
      ]),
    )
  })

  it.each([";;", ";=x", ";tag=a b", ";tag=", "tag=1", ';x="a\\"', ";x=\x00"])(
    "rejects %j",
    (value) => {
      expect(() => parseParams(value)).toThrow(ParseError)
    },
  )

  it("accepts up to 32 parameters and rejects more", () => {
    const params = (count: number) => Array.from({ length: count }, (_, i) => `;p${i}`).join("")
    expect(parseParams(params(32)).size).toBe(32)
    expect(() => parseParams(params(33))).toThrow("Too many parameters (limit 32)")
  })
})

describe("isParams", () => {
  it.each([
    new Map([["tag", "abc"]]),
    new Map([["lr", null]]),
    new Map([["received", "2001:db8::1"]]),
    new Map([["x", '"quoted \\\x00 nul"']]),
  ])("accepts %o", (params) => {
    expect(isParams(params)).toBe(true)
  })

  it.each([
    new Map([["ta g", "abc"]]),
    new Map([["tag", "a b"]]),
    new Map([["tag", "a\r\nX: y"]]),
    new Map([["x", '"line\r\nbreak"']]),
    new Map([["x", '"raw \x00 nul"']]),
  ])("rejects %o", (params) => {
    expect(isParams(params)).toBe(false)
  })
})

describe("formatParams", () => {
  it("writes flags and values in order", () => {
    expect(
      formatParams(
        new Map([
          ["lr", null],
          ["tag", "abc"],
        ]),
      ),
    ).toBe(";lr;tag=abc")
  })
})
