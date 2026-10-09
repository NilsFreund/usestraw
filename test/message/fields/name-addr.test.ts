import { describe, expect, it } from "vitest"
import { formatNameAddr, isNameAddr, parseNameAddr } from "../../../src/message/fields/name-addr"
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

describe("isNameAddr", () => {
  const valid = parseNameAddr('"Alice" <sip:alice@example.com>;tag=1')

  it.each([
    valid,
    { ...valid, displayName: "BEL:\x07 NUL:\x00" },
    { uri: "tel:+49", params: new Map() },
  ])("accepts %o", (address) => {
    expect(isNameAddr(address)).toBe(true)
  })

  it.each([
    { ...valid, displayName: "Alice\r\nX-Injected: yes" },
    { ...valid, uri: "sip:alice@example.com>\r\nX: y" },
    { ...valid, uri: "alice" },
    { ...valid, params: new Map([["tag", "1\r\nX: y"]]) },
  ])("rejects %o", (address) => {
    expect(isNameAddr(address)).toBe(false)
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
