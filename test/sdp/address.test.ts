import { describe, expect, it } from "vitest"
import { familyOf, isPrivate, isUnspecified, sameHost } from "../../src/sdp/address"

describe("media addresses", () => {
  it.each([
    ["192.0.2.1", "IP4"],
    ["0.0.0.0", "IP4"],
    ["223.255.255.255", "IP4"],
    ["2001:db8::1", "IP6"],
    ["::", "IP6"],
    ["224.0.0.1", undefined],
    ["255.255.255.255", undefined],
    ["192.0.2.256", undefined],
    ["ff02::1", undefined],
    ["FF05::2", undefined],
    ["fe80::1%en0", undefined],
    ["[2001:db8::1]", undefined],
    ["media.example.com", undefined],
  ])("sees %s as %s", (host, family) => {
    expect(familyOf(host)).toBe(family)
  })

  it.each(["0.0.0.0", "000.000.000.000", "::", "::0", "0:0:0:0:0:0:0:0"])(
    "knows %s means nowhere",
    (host) => {
      expect(isUnspecified(host)).toBe(true)
    },
  )

  it.each(["192.0.2.1", "::1", "10.0.0.0"])("knows %s is somewhere", (host) => {
    expect(isUnspecified(host)).toBe(false)
  })

  it.each([
    ["192.0.2.1", "192.0.2.1", true],
    ["192.0.2.1", "192.0.2.2", false],
    ["::1", "0:0:0:0:0:0:0:1", true],
    ["2001:DB8::", "2001:db8:0:0:0:0:0:0", true],
    ["2001:db8:0:0:0:0:0:5", "2001:db8::5", true],
    ["2001:0db8::0005", "2001:db8::5", true],
    ["2001:db8::5", "2001:db8::6", false],
    ["::FFFF:192.0.2.1", "::ffff:192.0.2.1", true],
    ["a::b::c", "A::B::C", true],
  ])("compares %s and %s as %s", (a, b, same) => {
    expect(sameHost(a, b)).toBe(same)
  })
})

describe("isPrivate", () => {
  it.each([
    "10.0.0.5",
    "127.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "100.64.0.1",
    "100.127.255.255",
    "169.254.1.1",
    "fd00::5",
    "FC00::1",
    "fe80::1",
    "febf::1",
    "::1",
  ])("knows %s lives behind a NAT or on the link", (host) => {
    expect(isPrivate(host)).toBe(true)
  })

  it.each([
    "192.0.2.20",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "192.169.0.1",
    "169.253.1.1",
    "11.0.0.1",
    "2001:db8::5",
    "fec0::1",
    "::",
  ])("takes %s for a public address", (host) => {
    expect(isPrivate(host)).toBe(false)
  })
})
