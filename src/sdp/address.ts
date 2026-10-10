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
