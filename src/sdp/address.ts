import { bareHost, isIp } from "../message/fields/host"

export type Family = "IP4" | "IP6"

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const GROUP = /^[0-9a-f]{1,4}$/i
const PREFIX = /^(?:0|[1-9]\d{0,2})$/
const MAPPED = `${"0".repeat(80)}${"1".repeat(16)}`

/** An address and how many of its leading bits count. */
export interface Range {
  readonly bits: string
  readonly prefix: number
}

// RFC 1918, RFC 6598, RFC 3927, RFC 4193 and RFC 4291: addresses that only exist behind a NAT
const PRIVATE = [
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
  "fe80::/10",
  "::1",
].map((range) => parseRange(range) as Range)

// RTP goes to one unicast address, so names, zones, multicast and broadcast cannot carry a call
export function familyOf(host: string): Family | undefined {
  if (!isIp(host) || /[%[]/.test(host)) return undefined
  if (host.includes(":")) return /^ff/i.test(host) ? undefined : "IP6"
  const [first = 0, ...rest] = host.split(".").map(Number)
  return first < 224 && rest.every((octet) => octet <= 255) ? "IP4" : undefined
}

// RFC 3264 §8.4: 0.0.0.0 and :: in any spelling mean "do not send to me", once the host is known to be an IP
export function isUnspecified(host: string): boolean {
  return /^[0.:]+$/.test(host)
}

export function isPrivate(host: string): boolean {
  return PRIVATE.some((range) => inRange(host, range))
}

// Hosts compare by value: case, brackets and the shorthand of IPv6 do not make another address
export function sameHost(a: string, b: string): boolean {
  return (hostBits(a) ?? a.toLowerCase()) === (hostBits(b) ?? b.toLowerCase())
}

// RFC 4632 and RFC 4291 §2.3, strictly: no zones, no leading zeros and no bits beyond the prefix
export function parseRange(range: string): Range | undefined {
  const [address = "", prefix, ...rest] = range.split("/")
  const bits = bitsOf(address)
  if (!bits || rest.length > 0) return undefined
  const length = prefix === undefined ? bits.length : Number(prefix)
  if (prefix !== undefined && (!PREFIX.test(prefix) || length > bits.length)) return undefined
  return bits.slice(length).includes("1") ? undefined : { bits, prefix: length }
}

export function inRange(host: string, range: Range): boolean {
  const bits = hostBits(host)
  return bits?.length === range.bits.length && bits.startsWith(range.bits.slice(0, range.prefix))
}

function hostBits(host: string): string | undefined {
  return bitsOf(bareHost(host))
}

// RFC 4291 §2.5.5.2: an IPv4-mapped IPv6 address is that IPv4 address
function bitsOf(address: string): string | undefined {
  if (!address.includes(":")) return ipv4Bits(address)
  const halves = address.split("::")
  if (halves.length > 2) return undefined
  const parts = halves.map((half, index) => groupBits(half, index === halves.length - 1))
  if (parts.includes(undefined)) return undefined
  const [head = "", tail = ""] = parts
  const missing = 128 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 16) return undefined
  const bits = `${head}${"0".repeat(missing)}${tail}`
  return bits.startsWith(MAPPED) ? bits.slice(MAPPED.length) : bits
}

// RFC 4291 §2.2: the last 32 bits may be written as an IPv4 address
function groupBits(half: string, last: boolean): string | undefined {
  const groups = half === "" ? [] : half.split(":")
  const tail = last ? groups.at(-1) : undefined
  const dotted = tail?.includes(".") ? ipv4Bits(tail) : ""
  const hex = dotted ? groups.slice(0, -1) : groups
  if (dotted === undefined || !hex.every((group) => GROUP.test(group))) return undefined
  const bits = hex.map((group) => Number.parseInt(group, 16).toString(2).padStart(16, "0"))
  return `${bits.join("")}${dotted}`
}

function ipv4Bits(address: string): string | undefined {
  const octets = IPV4.exec(address)?.slice(1)
  if (!octets?.every((octet) => Number(octet) <= 255 && !/^0\d/.test(octet))) return undefined
  return octets.map((octet) => Number(octet).toString(2).padStart(8, "0")).join("")
}
