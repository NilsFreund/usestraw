import { describe, expect, it } from "vitest"
import { isRequestUri, isSipUri, isUri, splitSipUri } from "../../../src/message/fields/uri"

describe("isUri", () => {
  it("rejects objects that only look like URIs", () => {
    expect(isUri({ toString: () => "sip:a@b" } as unknown as string)).toBe(false)
  })

  it.each(["sip:alice@example.com", "tel:+4930123456", "urn:uuid:f81d4fae", "soap.beep://h:1"])(
    "accepts %s",
    (value) => {
      expect(isUri(value)).toBe(true)
    },
  )

  it.each([
    "alice",
    "<sip:alice@example.com>",
    "sip:alice @example.com",
    "1sip:x",
    "sip:alice@example.com\r\nX: y",
    "sip:a\x00@example.com",
    "sip:a\x1b@example.com",
    "sip:a\x7f@example.com",
    "sip:a\u2028@example.com",
  ])("rejects %j", (value) => {
    expect(isUri(value)).toBe(false)
  })
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

describe("splitSipUri", () => {
  it.each([
    ["sip:alice@example.com", { scheme: "sip", user: "alice", hostport: "example.com" }],
    [
      "SIPS:alice@example.com:5061;transport=tls",
      { scheme: "sips", user: "alice", hostport: "example.com:5061" },
    ],
    [
      "sip:alice;ext=1@example.com",
      { scheme: "sip", user: "alice;ext=1", hostport: "example.com" },
    ],
    ["sip:example.com?Subject=x", { scheme: "sip", hostport: "example.com" }],
    ["sip:[2001:db8::1]:5060", { scheme: "sip", hostport: "[2001:db8::1]:5060" }],
  ])("splits %s", (uri, parts) => {
    expect(splitSipUri(uri)).toStrictEqual(parts)
  })

  it.each(["tel:+4930123456", "urn:uuid:f81d4fae", "sipx:alice@example.com"])(
    "ignores %s",
    (uri) => {
      expect(splitSipUri(uri)).toBeUndefined()
    },
  )
})
