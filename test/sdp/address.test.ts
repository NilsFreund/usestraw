import { describe, expect, it } from "vitest"
import {
  familyOf,
  inRange,
  isPrivate,
  isUnspecified,
  parseRange,
  sameIp,
} from "../../src/sdp/address"

function within(host: string, range: string): boolean {
  const parsed = parseRange(range)
  if (!parsed) throw new Error(`Not a range: ${range}`)
  return inRange(host, parsed)
}

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
    ["Media.Example.com", "media.example.com", true],
  ])("compares %s and %s as %s", (a, b, same) => {
    expect(sameIp(a, b)).toBe(same)
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
    "::ffff:10.1.2.3",
    "fd00::5",
    "fdff::1",
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
    "fbff::1",
    "::",
    "9.255.255.255",
    "126.255.255.255",
    "128.0.0.1",
    "169.255.0.1",
    "::ffff:192.0.2.20",
  ])("takes %s for a public address", (host) => {
    expect(isPrivate(host)).toBe(false)
  })
})

describe("ranges", () => {
  it.each([
    ["192.0.2.7", "192.0.2.0/24"],
    ["192.0.2.7", "192.0.2.7"],
    ["192.0.2.7", "192.0.2.7/32"],
    ["203.0.113.9", "0.0.0.0/0"],
    ["54.172.60.3", "54.172.60.0/30"],
    ["2001:db8::5", "2001:db8::/32"],
    ["2001:DB8:0:0:0:0:0:5", "2001:db8::5/128"],
    ["::1", "::/0"],
    ["[2001:db8::5]", "2001:db8::/64"],
    ["fe80::1%en0", "fe80::/10"],
    ["::ffff:192.0.2.7", "192.0.2.0/24"],
    ["::FFFF:c000:207", "192.0.2.7"],
    ["192.0.2.7", "::ffff:192.0.2.7"],
    ["64:ff9b::192.0.2.7", "64:ff9b::/96"],
  ])("finds %s in %s", (host, range) => {
    expect(within(host, range)).toBe(true)
  })

  it.each([
    ["192.0.3.7", "192.0.2.0/24"],
    ["54.172.60.4", "54.172.60.0/30"],
    ["192.0.2.8", "192.0.2.7"],
    ["2001:db9::5", "2001:db8::/32"],
    ["192.0.2.7", "::/0"],
    ["::ffff:192.0.2.7", "::/0"],
    ["::fffe:192.0.2.7", "192.0.2.0/24"],
    ["010.0.0.1", "10.0.0.0/8"],
    ["sip.example.com", "0.0.0.0/0"],
  ])("keeps %s out of %s", (host, range) => {
    expect(within(host, range)).toBe(false)
  })

  it.each([
    ["192.0.2.0/24", 24],
    ["192.0.2.1", 32],
    ["10.0.0.0/8", 8],
    ["0.0.0.0/0", 0],
    ["2001:db8::/32", 32],
    ["::/0", 0],
    ["1:2:3:4:5:6:7:8/128", 128],
    ["::ffff:192.0.2.0/24", 24],
    ["::1.2.3.4", 128],
  ])("reads %s with a prefix of %i", (range, prefix) => {
    expect(parseRange(range)?.prefix).toBe(prefix)
  })

  it.each([
    "",
    "/24",
    "192.0.2.0/",
    "192.0.2.0/33",
    "192.0.2.0/-1",
    "192.0.2.0/2a",
    "192.0.2.0/024",
    "192.0.2.0/ 24",
    "192.0.2.0/24/8",
    "192.0.2.5/24",
    "203.0.113.5/2",
    "2001:db8::1/32",
    "192.0.2.256/24",
    "192.0.2/24",
    "010.0.0.0/8",
    "10.0.0.01",
    "[10.0.0.1]",
    "[10.0.0.12",
    "10.0.0.1%x",
    "fe80::1%eth0",
    "[::1]",
    "2001:db8::/129",
    "::ffff:0:0/96",
    "1:2:3:4:5:6:7:8:9",
    "1:2:3:4:5:6:7",
    "1:2:3:4::5:6:7:8",
    "1::2::3",
    "12345::",
    "g::",
    "1.2.3.4::",
    "1.2.3.4:5::",
    "::1.2.3.4:5",
    "::1.2.3",
    "sip.example.com",
  ])("refuses %s as a range", (range) => {
    expect(parseRange(range)).toBeUndefined()
  })

  it("compares bracketed, mapped and shorthand addresses by value, but not leading zeros", () => {
    expect(sameIp("[::1]", "::1")).toBe(true)
    expect(sameIp("::ffff:192.0.2.1", "192.0.2.1")).toBe(true)
    expect(sameIp("010.0.0.1", "10.0.0.1")).toBe(false)
  })
})
