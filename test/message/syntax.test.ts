import { describe, expect, it } from "vitest"
import { isToken, quote, readQuoted, splitOutside } from "../../src/message/syntax"

describe("splitOutside", () => {
  it("ignores separators inside quotes and angle brackets", () => {
    expect(splitOutside('"a,b" <sip:x;y,z>, c', ",")).toEqual(['"a,b" <sip:x;y,z>', " c"])
  })

  it("rejects unterminated quotes", () => {
    expect(() => splitOutside('"a,b', ",")).toThrow("Unterminated quoted string")
  })
})

describe("readQuoted", () => {
  it("unescapes quoted pairs and returns the end index", () => {
    expect(readQuoted('x"a\\"b\\\\"y', 1)).toEqual(['a"b\\', 9])
  })
})

describe("quote", () => {
  it("escapes quotes, backslashes and control characters", () => {
    expect(quote('a"b\\c\x00')).toBe('"a\\"b\\\\c\\\x00"')
  })
})

describe("isToken", () => {
  it.each(["INVITE", "z9hG4bK-.!%*_+`'~"])("accepts %s", (value) => {
    expect(isToken(value)).toBe(true)
  })

  it.each(["", "a b", "a,b", "a;b", "a:b"])("rejects %s", (value) => {
    expect(isToken(value)).toBe(false)
  })
})
