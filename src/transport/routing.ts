import { sameHost } from "../message/fields/host"
import type { Via } from "../message/fields/via"
import type { SipResponse } from "../message/types"
import { defaultPort, isReliable, type TransportAddress } from "./address"

export function replyAddress(via: Via | undefined, from: TransportAddress): TransportAddress {
  if (isReliable(from) || via?.params.has("rport")) return from
  return { ...from, port: via?.port ?? defaultPort(from.transport) }
}

export function acceptsResponse(response: SipResponse, local: TransportAddress): boolean {
  const [via, ...rest] = response.via
  return (
    rest.length === 0 &&
    via !== undefined &&
    via.transport === local.transport &&
    sameHost(via.host, local.host) &&
    via.port === local.port
  )
}
