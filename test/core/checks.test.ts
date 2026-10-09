import { describe, expect, it } from "vitest"
import {
  checkAddress,
  checkCredentials,
  checkExpires,
  checkRegistrar,
  checkRequestUri,
  checkSource,
} from "../../src/core/checks"
import { alice } from "../helpers"

describe("checkAddress", () => {
  it("accepts a valid address and rejects an invalid one", () => {
    expect(() => checkAddress(alice)).not.toThrow()
    expect(() => checkAddress({ ...alice, port: 70_000 })).toThrow(TypeError)
  })
})

describe("checkRequestUri", () => {
  it("rejects URIs that cannot be a Request-URI", () => {
    expect(() => checkRequestUri("sip:example.com")).not.toThrow()
    expect(() => checkRequestUri("sip:a@b?Route=x")).toThrow(
      new TypeError('Invalid Request-URI "sip:a@b?Route=x"'),
    )
  })
})

describe("checkSource", () => {
  it("needs a valid address with an IP host", () => {
    expect(() => checkSource({ ...alice, host: "fe80::1%en0" })).not.toThrow()
    expect(() => checkSource({ ...alice, host: "client.example.com" })).toThrow(
      new TypeError('The source must be an IP address, got "client.example.com"'),
    )
    expect(() => checkSource({ ...alice, port: -1 })).toThrow(TypeError)
  })
})

describe("checkRegistrar", () => {
  it.each(["sip:example.com", "sips:example.com:5061", "sip:[2001:db8::1]"])(
    "accepts %s",
    (uri) => {
      expect(() => checkRegistrar(uri)).not.toThrow()
    },
  )

  it.each([
    undefined,
    "example.com",
    "sip:bob@example.com",
    "tel:+4930123",
    "sip:example.com?Route=x",
  ])("rejects %s", (uri) => {
    expect(() => checkRegistrar(uri)).toThrow(TypeError)
  })
})

describe("checkExpires", () => {
  it.each([1, 3600, 0xffffffff])("accepts %d seconds", (expires) => {
    expect(() => checkExpires(expires)).not.toThrow()
  })

  it.each([0, -1, 1.5, 2 ** 32, Number.NaN])("rejects %d seconds", (expires) => {
    expect(() => checkExpires(expires)).toThrow(new RangeError(`Invalid expires ${expires}`))
  })
})

describe("checkCredentials", () => {
  it("accepts usernames, passwords and realms without line breaks", () => {
    expect(() => checkCredentials({ username: "alice", password: "p@ss word" })).not.toThrow()
    expect(() => checkCredentials({ username: "a", password: "b", realm: "r" })).not.toThrow()
  })

  it.each([
    { username: "alice\r\nX: y", password: "p" },
    { username: "alice", password: "p\n" },
    { username: "alice", password: "p", realm: "r\r" },
    { username: "alice", password: 1 as unknown as string },
  ])("rejects %o", (credentials) => {
    expect(() => checkCredentials(credentials)).toThrow(
      new TypeError("Credentials must be strings without line breaks"),
    )
  })
})
