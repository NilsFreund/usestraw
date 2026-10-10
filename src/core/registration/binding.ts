import { parseDeltaSeconds } from "../../message/fields/delta-seconds"
import { formatHost } from "../../message/fields/host"
import type { NameAddr } from "../../message/fields/name-addr"
import { splitSipUri } from "../../message/fields/uri"
import { getHeader } from "../../message/headers"
import type { SipResponse } from "../../message/types"
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

// RFC 3261 §10.2.1 and §26.2.2: sips for TLS; RFC 7118 §5.2: transport=ws for WebSocket
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

export function defaultRegistrar(aor: string): string | undefined {
  const parts = splitSipUri(aor)
  return parts && `${parts.scheme}:${parts.hostport}`
}

// RFC 3261 §10.2.4: our Contact's expires, else the Expires header, else what we asked for;
// a registrar that rewrote our only Contact still tells us its expiry (as pjsip assumes)
export function grantedExpiry(response: SipResponse, contact: NameAddr, requested: number): number {
  const bindings = response.contact === "*" ? [] : response.contact
  const ours = bindings.find((binding) => sameBinding(binding.uri, contact.uri))
  const only = bindings.length === 1 ? bindings[0] : undefined
  const granted =
    parseDeltaSeconds((ours ?? only)?.params.get("expires")) ??
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
