import { sameHost, type Via } from "../message/fields/via"
import type { SipResponse } from "../message/types"
import { type Address, defaultPort, isReliable } from "./address"

export function replyAddress(via: Via | undefined, from: Address): Address {
  if (isReliable(from) || via?.params.has("rport")) return from
  return { ...from, port: via?.port ?? defaultPort(from.transport) }
}

export function acceptsResponse(response: SipResponse, local: Address): boolean {
  const [via, ...rest] = response.via
  return (
    rest.length === 0 &&
    via !== undefined &&
    via.transport === local.transport &&
    sameHost(via.host, local.host) &&
    via.port === local.port
  )
}
