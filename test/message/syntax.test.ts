import { describe, expect, it } from "vitest"
import {
  hasControl,
  hasLineBreak,
  hasRawControl,
  isText,
  isToken,
  QUOTED_STRING,
  quote,
  readQuoted,
  show,
  splitList,
  splitOutside,
} from "../../src/message/syntax"

describe("splitList", () => {
  it("splits on commas, trims and drops empty items", () => {
    expect(splitList(" a , b,, c ,")).toStrictEqual(["a", "b", "c"])
    expect(splitList("")).toStrictEqual([])
  })
})

describe("QUOTED_STRING", () => {
  const quoted = new RegExp(`^${QUOTED_STRING}$`)

  it.each(['""', '"a b"', '"a\\"b"', '"\\\\"'])("matches %s", (value) => {
    expect(quoted.test(value)).toBe(true)
  })

  it.each(['"a', 'a"', '"a"b"', '"\\"'])("does not match %s", (value) => {
    expect(quoted.test(value)).toBe(false)
  })
})

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
  it("escapes quotes, backslashes and control characters but keeps tabs", () => {
    expect(quote('a"b\\c\x00\t\x7f')).toBe('"a\\"b\\\\c\\\x00\t\\\x7f"')
  })

  it.each(["a\rb", "a\nb", "a\r\nX-Injected: yes"])("refuses line breaks in %j", (text) => {
    expect(() => quote(text)).toThrow(TypeError)
  })
})

const sneaky = { toString: () => "INVITE" } as unknown as string

describe("isText", () => {
  it("accepts only primitive strings", () => {
    expect(isText("")).toBe(true)
    expect(isText(sneaky)).toBe(false)
    expect(isText(1)).toBe(false)
  })
})

describe("isToken", () => {
  it("rejects objects that only look like tokens", () => {
    expect(isToken(sneaky)).toBe(false)
  })

  it.each(["INVITE", "z9hG4bK-.!%*_+`'~"])("accepts %s", (value) => {
    expect(isToken(value)).toBe(true)
  })

  it.each(["", "a b", "a,b", "a;b", "a:b", "a\r\nb", "ä"])("rejects %j", (value) => {
    expect(isToken(value)).toBe(false)
  })
})

describe("hasControl", () => {
  it.each(["\x00", "\x07", "\r", "\n", "\x1b", "\x7f"])("finds %j", (char) => {
    expect(hasControl(`a${char}b`)).toBe(true)
  })

  it.each(["plain text", "tab\tseparated", "ümlaut", "line\u2028separator", "c1\x85\x9f"])(
    "accepts %j",
    (value) => {
      expect(hasControl(value)).toBe(false)
    },
  )
})

describe("hasLineBreak", () => {
  it.each([
    ["a\rb", true],
    ["a\nb", true],
    ["a\x00b", false],
    ["a\u2028b", false],
  ])("checks %j", (value, expected) => {
    expect(hasLineBreak(value)).toBe(expected)
  })
})

describe("hasRawControl", () => {
  it.each([
    ['"BEL:\\\x07 NUL:\\\x00 DEL:\\\x7f" <sip:x@y>', false],
    ["tab\tseparated", false],
    ['"a\\"b" <sip:x@y>', false],
    ["raw\x00nul", true],
    ['"unescaped\x00inside quotes"', true],
    ['"escaped CR\\\r"', true],
    ['"escaped LF\\\n"', true],
    ['comment (it"s) \\\x00', false],
    ["lone\rcarriage return", true],
    ["trailing backslash\\", false],
  ])("checks %j", (value, expected) => {
    expect(hasRawControl(value)).toBe(expected)
  })
})

describe("show", () => {
  it.each([
    ["plain", '"plain"'],
    ["a\r\nb\x00\x1b", '"a\\r\\nb\\u0000\\u001b"'],
    [42, "42"],
    [undefined, "undefined"],
  ])("renders %j as %s", (value, shown) => {
    expect(show(value)).toBe(shown)
  })

  it("escapes characters that log tools treat as line breaks or controls", () => {
    expect(show("a\x7fb\x85c\x9bd\u2028e\u2029f")).toBe(
      '"a\\u007fb\\u0085c\\u009bd\\u2028e\\u2029f"',
    )
  })

  it("escapes invisible format characters such as bidi overrides", () => {
    expect(show("a‮b​c﻿d\u{e0001}e")).toBe('"a\\u202eb\\u200bc\\ufeffd\\udb40\\udc01e"')
  })

  it("cuts long values", () => {
    expect(show("x".repeat(500))).toBe(`"${"x".repeat(96)}...`)
    expect(show("x".repeat(98))).toHaveLength(100)
  })
})
