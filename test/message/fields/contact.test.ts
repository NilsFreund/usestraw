import { describe, expect, it } from "vitest"
import { formatContact, parseContact } from "../../../src/message/fields/contact"
import { ParseError } from "../../../src/message/syntax"

describe("parseContact", () => {
  it("parses the wildcard", () => {
    expect(parseContact(["*"])).toBe("*")
  })

  it("splits lists without breaking quoted display names", () => {
    const contact = parseContact(['"Doe, John" <sip:john@a.example>, <sip:john@b.example>'])
    expect(contact).toEqual([
      { displayName: "Doe, John", uri: "sip:john@a.example", params: new Map() },
      { uri: "sip:john@b.example", params: new Map() },
    ])
  })

  it.each([[["*", "<sip:a@b>"]], [["*, <sip:a@b>"]], [["<sip:a@b>", "*"]]])(
    "rejects the wildcard mixed with addresses in %j",
    (values) => {
      expect(() => parseContact(values)).toThrow(ParseError)
    },
  )

  it("accepts up to 64 entries and rejects more", () => {
    const entries = (count: number) => [Array.from({ length: count }, () => "<sip:a@b>").join(",")]
    expect(parseContact(entries(64))).toHaveLength(64)
    expect(() => parseContact(entries(65))).toThrow("Too many Contact entries (limit 64)")
  })

  it("returns an empty list without Contact headers", () => {
    expect(parseContact([])).toEqual([])
  })
})

describe("formatContact", () => {
  it("formats each address and the wildcard", () => {
    expect(formatContact("*")).toEqual(["*"])
    expect(formatContact(parseContact(["<sip:a@b>;expires=60"]))).toEqual(["<sip:a@b>;expires=60"])
  })
})
