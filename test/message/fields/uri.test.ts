import { describe, expect, it } from "vitest"
import { isRequestUri, isSipUri, isUri } from "../../../src/message/fields/uri"

describe("isUri", () => {
  it.each(["sip:alice@example.com", "tel:+4930123456", "urn:uuid:f81d4fae", "soap.beep://h:1"])(
    "accepts %s",
    (value) => {
      expect(isUri(value)).toBe(true)
    },
  )

  it.each(["alice", "<sip:alice@example.com>", "sip:alice @example.com", "1sip:x"])(
    "rejects %s",
    (value) => {
      expect(isUri(value)).toBe(false)
    },
  )
})

describe("isRequestUri", () => {
  it("rejects SIP URIs with headers", () => {
    expect(isRequestUri("sip:alice@example.com?Route=x")).toBe(false)
  })

  it("allows ? in the user part", () => {
    expect(isRequestUri("sip:crazy?user@example.com")).toBe(true)
  })

  it("allows ? in other schemes", () => {
    expect(isRequestUri("http://example.com/?q=1")).toBe(true)
  })
})

describe("isSipUri", () => {
  it.each(["sip:alice@example.com", "sips:alice@example.com", "SIP:alice@example.com"])(
    "accepts %s",
    (value) => {
      expect(isSipUri(value)).toBe(true)
    },
  )

  it.each(["tel:+4930123456", "sipx:alice", "http://example.com"])("rejects %s", (value) => {
    expect(isSipUri(value)).toBe(false)
  })
})
