import { sameHost } from "../message/fields/host"
import type { Via } from "../message/fields/via"
import type { SipResponse } from "../message/types"
import { defaultPort, isReliable, sentByPort, type TransportAddress } from "./address"

// RFC 3261 §18.2.2 and RFC 3581 §4: answers go back to the source port when the Via asks with rport
export function replyAddress(via: Via | undefined, from: TransportAddress): TransportAddress {
  if (isReliable(from) || via?.params.has("rport")) return from
  return { ...from, port: via?.port ?? defaultPort(from.transport) }
}

// RFC 3261 §18.1.2: a response is ours only if its single Via names our transport and address
export function acceptsResponse(response: SipResponse, local: TransportAddress): boolean {
  const [via, ...rest] = response.via
  return (
    rest.length === 0 &&
    via !== undefined &&
    via.transport === local.transport &&
    sameHost(via.host, local.host) &&
    via.port === sentByPort(local)
  )
}
