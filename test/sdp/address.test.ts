import { describe, expect, it } from "vitest"
import { familyOf, isUnspecified, sameHost } from "../../src/sdp/address"

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
