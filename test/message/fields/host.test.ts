import { describe, expect, it } from "vitest"
import {
  formatHost,
  isHost,
  isPort,
  isSocketHost,
  sameHost,
} from "../../../src/message/fields/host"
import { bareHost, isIp } from "../../../src/support/ip"

describe("isHost", () => {
  it.each(["192.0.2.1", "host.example.com", "[2001:db8::1]"])("accepts %s", (host) => {
    expect(isHost(host)).toBe(true)
  })

  it.each(["", "a b", "host\r\n", "2001:db8::1", "[x]", "host:5060", "[1.2.3.4]"])(
    "rejects %j",
    (host) => {
      expect(isHost(host)).toBe(false)
    },
  )
})

describe("isIp", () => {
  it.each(["192.0.2.1", "2001:db8::1", "[2001:db8::1]", "fe80::1%en0", "::ffff:192.0.2.1"])(
    "accepts %s",
    (host) => {
      expect(isIp(host)).toBe(true)
    },
  )

  it.each(["host.example.com", "cafe", "1.2.3", "1.2.3.4%en0", "[1.2.3.4]", "cafe%en0", ""])(
    "rejects %j",
    (host) => {
      expect(isIp(host)).toBe(false)
    },
  )
})

describe("formatHost", () => {
  it.each([
    ["192.0.2.1", "192.0.2.1"],
    ["host.example.com", "host.example.com"],
    ["2001:db8::1", "[2001:db8::1]"],
    ["[2001:db8::1]", "[2001:db8::1]"],
  ])("formats %s as %s", (host, expected) => {
    expect(formatHost(host)).toBe(expected)
  })
})

describe("bareHost", () => {
  it.each([
    ["[2001:db8::1]", "2001:db8::1"],
    ["2001:db8::1", "2001:db8::1"],
    ["192.0.2.1", "192.0.2.1"],
  ])("strips brackets from %s", (host, expected) => {
    expect(bareHost(host)).toBe(expected)
  })
})

describe("sameHost", () => {
  it.each([
    ["Host.Example.com", "host.example.com"],
    ["[2001:DB8::1]", "2001:db8::1"],
    ["192.0.2.1", "192.0.2.1"],
  ])("treats %s and %s as the same host", (a, b) => {
    expect(sameHost(a, b)).toBe(true)
  })

  it("tells different hosts apart", () => {
    expect(sameHost("192.0.2.1", "192.0.2.2")).toBe(false)
  })
})

describe("isSocketHost", () => {
  it("rejects hosts that are not strings, like isHost", () => {
    const sneaky = { toString: () => "192.0.2.1" } as unknown as string
    expect(isHost(sneaky)).toBe(false)
    expect(isSocketHost(sneaky)).toBe(false)
  })

  it.each([
    "192.0.2.1",
    "host.example.com",
    "2001:db8::1",
    "[2001:db8::1]",
    "fe80::1%en0",
    "[fe80::1%lo0]",
    "fe80::1%eth0.100",
  ])("accepts %s", (host) => {
    expect(isSocketHost(host)).toBe(true)
  })

  it.each([
    "",
    "a b",
    "[::1",
    "::1]",
    "fe80::1%",
    "fe80::1%a b",
    "fe80::1%en0\r\nX: y",
    "h%en0",
    "cafe%en0",
    "1.2.3.4%en0",
    "[1.2.3.4]",
  ])("rejects %j", (host) => {
    expect(isSocketHost(host)).toBe(false)
  })
})

describe("isPort", () => {
  it.each([0, 5060, 65535])("accepts %d", (port) => {
    expect(isPort(port)).toBe(true)
  })

  it.each([-1, 65536, 5060.5, Number.NaN])("rejects %d", (port) => {
    expect(isPort(port)).toBe(false)
  })
})

describe("zone identifiers", () => {
  it("strips the zone from bare and bracketed hosts", () => {
    expect(bareHost("fe80::1%en0")).toBe("fe80::1")
    expect(bareHost("[fe80::1%en0]")).toBe("fe80::1")
  })

  it("formats a zoned host for Via without the zone", () => {
    expect(formatHost("fe80::1%en0")).toBe("[fe80::1]")
  })

  it("compares hosts without their zone", () => {
    expect(sameHost("[FE80::1]", "fe80::1%en0")).toBe(true)
  })
})
