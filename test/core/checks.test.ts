import { describe, expect, it } from "vitest"
import {
  checkAddress,
  checkAor,
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

describe("length limits", () => {
  const host = (length: number) => `sip:${"a".repeat(length - 16)}@example.com`

  it("takes URIs, user names and realms of up to 4096 characters", () => {
    expect(host(4096)).toHaveLength(4096)
    expect(() => checkRequestUri(host(4096))).not.toThrow()
    expect(() => checkAor(host(4096))).not.toThrow()
    expect(() => checkRegistrar(`sip:${"a".repeat(4088)}.com`)).not.toThrow()
    const name = "a".repeat(4096)
    expect(() => checkCredentials({ username: name, password: "p", realm: name })).not.toThrow()
  })

  it("refuses longer ones before they turn into a message too big to send", () => {
    const tooLong = new RangeError("A URI must be at most 4096 characters, got 4097")
    expect(() => checkRequestUri(host(4097))).toThrow(tooLong)
    expect(() => checkAor(host(4097))).toThrow(tooLong)
    expect(() => checkRegistrar(`sip:${"a".repeat(4089)}.com`)).toThrow(tooLong)
    const name = "a".repeat(4097)
    expect(() => checkCredentials({ username: name, password: "p" })).toThrow(
      new RangeError("A user name must be at most 4096 characters, got 4097"),
    )
    expect(() => checkCredentials({ username: "a", password: "p", realm: name })).toThrow(
      new RangeError("A realm must be at most 4096 characters, got 4097"),
    )
    expect(() => checkAor("alice")).toThrow(new TypeError('Invalid address of record "alice"'))
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
