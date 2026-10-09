import { describe, expect, it } from "vitest"
import { findBlankLine, sliceBody, splitHead } from "../../src/message/framing"
import { ParseError } from "../../src/message/syntax"

const bytes = (text: string) => new TextEncoder().encode(text)

describe("splitHead", () => {
  it("splits at the first empty line", () => {
    expect(splitHead(bytes("A\r\nB: 1\r\n\r\nbody"))).toEqual(["A\r\nB: 1", 11])
  })

  it("accepts bare LF and skips leading empty lines", () => {
    expect(splitHead(bytes("\r\n\nA\nB: 1\n\nbody"))).toEqual(["A\nB: 1", 11])
  })

  it("rejects a missing empty line", () => {
    expect(() => splitHead(bytes("A\r\nB: 1\r\n"))).toThrow(ParseError)
  })

  it("rejects invalid UTF-8", () => {
    expect(() => splitHead(new Uint8Array([0x41, 0xff, 13, 10, 13, 10]))).toThrow(
      "Invalid UTF-8 in headers",
    )
  })
})

describe("sliceBody", () => {
  const data = bytes("headbody!")

  it("takes Content-Length bytes", () => {
    expect(sliceBody(data, 4, "4")).toEqual(bytes("body"))
  })

  it("takes the rest without Content-Length", () => {
    expect(sliceBody(data, 4, undefined)).toEqual(bytes("body!"))
  })

  it("copies instead of viewing the datagram", () => {
    const source = bytes("headbody")
    const body = sliceBody(source, 4, "4")
    source[4] = 0
    expect(body).toEqual(bytes("body"))
  })

  it.each(["-1", "abc", "6"])("rejects Content-Length %s", (length) => {
    expect(() => sliceBody(data, 4, length)).toThrow(ParseError)
  })
})

describe("findBlankLine", () => {
  const find = (text: string, start?: number) =>
    findBlankLine(new TextEncoder().encode(text), start)

  it.each([
    ["A\r\n\r\nB", [1, 5]],
    ["A\n\nB", [1, 3]],
    ["A\n\r\nB", [1, 4]],
    ["A\r\n\nB", [1, 4]],
  ])("finds the blank line in %j", (text, expected) => {
    expect(find(text)).toStrictEqual(expected)
  })

  it("starts searching at the given index", () => {
    expect(find("A\n\nB\n\nC", 3)).toStrictEqual([4, 6])
  })

  it.each(["A\r\n", "A\r\n\r", "A\n", "A\n\r", "A"])("needs more bytes for %j", (text) => {
    expect(find(text)).toBeUndefined()
  })
})
