import { describe, expect, it } from "vitest"
import { formatNameAddr, parseNameAddr } from "../../../src/message/fields/name-addr"
import { ParseError } from "../../../src/message/syntax"

describe("parseNameAddr", () => {
  it("unescapes quoted display names", () => {
    expect(parseNameAddr('"Alice \\"A\\"" <sip:alice@example.com>;tag=1')).toEqual({
      displayName: 'Alice "A"',
      uri: "sip:alice@example.com",
      params: new Map([["tag", "1"]]),
    })
  })

  it("joins token display names", () => {
    expect(parseNameAddr("Alice   Smith<sip:alice@example.com>").displayName).toBe("Alice Smith")
  })

  it("keeps URI parameters inside angle brackets", () => {
    expect(parseNameAddr("<sip:proxy.example.com;lr>")).toEqual({
      uri: "sip:proxy.example.com;lr",
      params: new Map(),
    })
  })

  it("treats parameters after a bare URI as header parameters", () => {
    expect(parseNameAddr("sip:alice@example.com;tag=1")).toEqual({
      uri: "sip:alice@example.com",
      params: new Map([["tag", "1"]]),
    })
  })

  it.each([
    '"Alice <sip:alice@example.com>',
    "Alice, Smith <sip:alice@example.com>",
    "< sip:alice@example.com >",
    "sip:alice@example.com?Route=x",
    "alice",
    "<sip:alice@example.com",
    '"Alice" sip:alice@example.com',
    "<sip:alice@example.com> tag=1",
  ])("rejects %s", (value) => {
    expect(() => parseNameAddr(value)).toThrow(ParseError)
  })
})

describe("formatNameAddr", () => {
  it("always quotes display names and uses angle brackets", () => {
    expect(
      formatNameAddr({
        displayName: 'Alice "A"',
        uri: "sip:alice@example.com",
        params: new Map([["tag", "1"]]),
      }),
    ).toBe('"Alice \\"A\\"" <sip:alice@example.com>;tag=1')
  })
})
