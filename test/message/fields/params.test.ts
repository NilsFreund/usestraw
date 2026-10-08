import { describe, expect, it } from "vitest"
import { formatParams, parseParams } from "../../../src/message/fields/params"
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

  it.each([";;", ";=x", ";tag=a b", ";tag=", "tag=1"])("rejects %s", (value) => {
    expect(() => parseParams(value)).toThrow(ParseError)
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
