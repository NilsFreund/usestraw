import { parseDeltaSeconds } from "../../message/fields/delta-seconds"
import { formatHost } from "../../message/fields/host"
import type { NameAddr } from "../../message/fields/name-addr"
import { splitSipUri } from "../../message/fields/uri"
import { getHeader } from "../../message/headers"
import type { SipResponse } from "../../message/types"
import { isIntegerIn } from "../../support/integer"
import { bareHost, familyOf, isIp, isPrivate, isUnspecified, sameIp } from "../../support/ip"
import { isWebSocket, sentByPort, type TransportAddress } from "../../transport/address"
import type { Random } from "../types"

const MIN_REFRESH = 5000

interface Binding {
  readonly contact: NameAddr
  readonly instance?: string | undefined
}
const TRANSPORT_PARAMS = {
  UDP: "",
  TCP: ";transport=tcp",
  TLS: "",
  WS: ";transport=ws",
  WSS: ";transport=ws",
}

// RFC 3261 §8.1.1.8 and §26.2.2: sips: over TLS; RFC 7118 §8: transport=ws, sips: only for a sips: AOR
export function createContact(address: TransportAddress, aor: string): NameAddr {
  const parts = splitSipUri(aor)
  const user = parts?.user
  const secure =
    address.transport === "TLS" || (address.transport === "WSS" && parts?.scheme === "sips")
  const scheme = secure ? "sips" : "sip"
  const port = sentByPort(address)
  const host = port === undefined ? formatHost(address.host) : `${formatHost(address.host)}:${port}`
  const userinfo = user === undefined ? "" : `${user}@`
  return {
    uri: `${scheme}:${userinfo}${host}${TRANSPORT_PARAMS[address.transport]}`,
    params: new Map(),
  }
}

// RFC 3581 §4: received and rport show where calls must come to; like pjsua, never a private one
export function publicAddress(
  response: SipResponse,
  current: TransportAddress,
): TransportAddress | undefined {
  if (current.transport !== "UDP") return undefined
  const via = response.via[0]
  const host = bareHost(via?.params.get("received") ?? "")
  const port = Number(via?.params.get("rport"))
  if (!isIp(host) || !isIntegerIn(port, 1, 65_535)) return undefined
  const same = sameIp(host, current.host)
  if (same && port === current.port) return undefined
  if (isPrivate(host) && (same || !isPrivate(current.host))) return undefined
  return { ...current, host, port }
}

// RFC 3581 §4: a public received with our own port as rport shows a NAT that keeps ports, like a cloud VM's
export function publicHost(response: SipResponse, local: TransportAddress): string | undefined {
  const via = response.via[0]
  const host = bareHost(via?.params.get("received") ?? "")
  // A WebSocket's port says nothing about audio, so its received alone counts
  const kept = isWebSocket(local.transport) || via?.params.get("rport") === String(local.port)
  const usable = familyOf(host) !== undefined && !isUnspecified(host) && !isPrivate(host)
  return kept && usable ? host : undefined
}

// RFC 5626 §4.2: dialogs over a WebSocket ask the edge to route back through the same flow
export function dialogContact(contact: NameAddr, address: TransportAddress): NameAddr {
  return isWebSocket(address.transport) ? { ...contact, uri: `${contact.uri};ob` } : contact
}

export function listsBinding(response: SipResponse, ours: Binding): boolean {
  const bindings = response.contact === "*" ? [] : response.contact
  return bindings.length === 0 || bindings.some((binding) => isOurs(binding, ours))
}

export function defaultRegistrar(aor: string): string | undefined {
  const parts = splitSipUri(aor)
  return parts && `${parts.scheme}:${parts.hostport}`
}

// RFC 3261 §10.2.4: Contact expires, else Expires, else ours; a rewritten Contact takes the soonest
export function grantedExpiry(response: SipResponse, own: Binding, requested: number): number {
  const bindings = response.contact === "*" ? [] : response.contact
  const ours = bindings.find((binding) => isOurs(binding, own))
  const expiries = (ours ? [ours] : bindings).flatMap((binding) => {
    const seconds = parseDeltaSeconds(binding.params.get("expires"))
    return seconds === undefined || (seconds === 0 && !ours) ? [] : [seconds]
  })
  const granted =
    (expiries.length > 0 ? Math.min(...expiries) : undefined) ??
    parseDeltaSeconds(getHeader(response, "Expires")) ??
    requested
  return Math.min(granted, requested)
}

export function refreshDelay(granted: number, random: Random): number {
  return Math.max(MIN_REFRESH, Math.round(granted * 1000 * (0.45 + random() / 10)))
}

// RFC 5626 §6: a registrar that rewrites the Contact, as Asterisk does over WebSocket, keeps the instance
function isOurs(binding: NameAddr, ours: Binding): boolean {
  const instance = ours.instance === undefined ? undefined : `"<${ours.instance}>"`
  return (
    sameBinding(binding.uri, ours.contact.uri) ||
    (instance !== undefined && binding.params.get("+sip.instance") === instance)
  )
}

function sameBinding(a: string, b: string): boolean {
  const [left, right] = [a, b].map((uri) => {
    const parts = splitSipUri(uri)
    return parts ? `${parts.scheme}:${parts.user ?? ""}@${parts.hostport}`.toLowerCase() : uri
  })
  return left === right
}
