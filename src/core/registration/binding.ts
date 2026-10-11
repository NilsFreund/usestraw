import { parseDeltaSeconds } from "../../message/fields/delta-seconds"
import { bareHost, formatHost, isIp } from "../../message/fields/host"
import type { NameAddr } from "../../message/fields/name-addr"
import { splitSipUri } from "../../message/fields/uri"
import { getHeader } from "../../message/headers"
import type { SipResponse } from "../../message/types"
import { isPrivate, sameHost as sameAddress } from "../../sdp/address"
import { isIntegerIn } from "../../support/integer"
import type { TransportAddress } from "../../transport/address"
import type { Random } from "../types"

const MIN_REFRESH = 5000
const TRANSPORT_PARAMS = {
  UDP: "",
  TCP: ";transport=tcp",
  TLS: "",
  WS: ";transport=ws",
  WSS: ";transport=ws",
}

// RFC 3261 §10.2.1 and §26.2.2: sips for TLS, which proxies route back over our connection;
// RFC 7118 §5.2: transport=ws for WebSocket
export function createContact(address: TransportAddress, aor: string): NameAddr {
  const user = splitSipUri(aor)?.user
  const scheme = address.transport === "TLS" || address.transport === "WSS" ? "sips" : "sip"
  const host = `${formatHost(address.host)}:${address.port}`
  const userinfo = user === undefined ? "" : `${user}@`
  return {
    uri: `${scheme}:${userinfo}${host}${TRANSPORT_PARAMS[address.transport]}`,
    params: new Map(),
  }
}

// RFC 3581 §4: received and rport show where the registrar saw us; behind a NAT over UDP that is
// the address calls have to come to. Like pjsua, never trade our address for a private one, nor
// follow a private port change
export function publicAddress(
  response: SipResponse,
  current: TransportAddress,
): TransportAddress | undefined {
  if (current.transport !== "UDP") return undefined
  const via = response.via[0]
  const host = bareHost(via?.params.get("received") ?? "")
  const port = Number(via?.params.get("rport"))
  if (!isIp(host) || !isIntegerIn(port, 1, 65_535)) return undefined
  const same = sameAddress(host, current.host)
  if (same && port === current.port) return undefined
  if (isPrivate(host) && (same || !isPrivate(current.host))) return undefined
  return { ...current, host, port }
}

export function listsBinding(response: SipResponse, contact: NameAddr): boolean {
  const bindings = response.contact === "*" ? [] : response.contact
  return bindings.length === 0 || bindings.some((binding) => sameBinding(binding.uri, contact.uri))
}

export function defaultRegistrar(aor: string): string | undefined {
  const parts = splitSipUri(aor)
  return parts && `${parts.scheme}:${parts.hostport}`
}

// RFC 3261 §10.2.4: our Contact's expires, else the Expires header, else what we asked for; a
// registrar that rewrote our Contact gets the soonest expiry among its bindings, to stay safe
export function grantedExpiry(response: SipResponse, contact: NameAddr, requested: number): number {
  const bindings = response.contact === "*" ? [] : response.contact
  const ours = bindings.find((binding) => sameBinding(binding.uri, contact.uri))
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

function sameBinding(a: string, b: string): boolean {
  const [left, right] = [a, b].map((uri) => {
    const parts = splitSipUri(uri)
    return parts ? `${parts.scheme}:${parts.user ?? ""}@${parts.hostport}`.toLowerCase() : uri
  })
  return left === right
}
