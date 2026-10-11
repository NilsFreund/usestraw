import { isIp } from "../message/fields/host"

export type Family = "IP4" | "IP6"

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

// RFC 1918, RFC 6598, RFC 3927, RFC 4193 and RFC 4291: addresses that only exist behind a NAT
export function isPrivate(host: string): boolean {
  if (host.includes(":")) {
    const full = canonical(host)
    const first = Number.parseInt(full, 16)
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || full === "0:0:0:0:0:0:0:1"
  }
  const [a, b = 0] = host.split(".").map(Number)
  if (a === 10 || a === 127) return true
  if (a === 172) return b >= 16 && b < 32
  if (a === 100) return b >= 64 && b < 128
  return (a === 192 && b === 168) || (a === 169 && b === 254)
}

// Hosts compare by value: case and the shorthand of IPv6 do not make another address
export function sameHost(a: string, b: string): boolean {
  return canonical(a) === canonical(b)
}

function canonical(host: string): string {
  const lower = host.toLowerCase()
  const halves = lower.split("::")
  if (!lower.includes(":") || lower.includes(".") || halves.length > 2) return lower
  const [head = "", tail = ""] = halves
  const left = head === "" ? [] : head.split(":")
  const right = tail === "" ? [] : tail.split(":")
  const zeros =
    halves.length === 2 ? Array(Math.max(0, 8 - left.length - right.length)).fill("0") : []
  return [...left, ...zeros, ...right]
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")
}
