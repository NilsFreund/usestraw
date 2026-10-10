import type { TransportAddress } from "../../../transport/address"
import type { NatBehavior } from "./types"

export function endpointKey(address: TransportAddress): string {
  return `${address.host}:${address.port}`
}

export function portKey(transport: string, port: number): string {
  return `${transport}:${port}`
}

export function mappingKey(
  behavior: NatBehavior,
  internal: TransportAddress,
  remote: TransportAddress,
): string {
  const base = `${internal.transport}:${endpointKey(internal)}`
  switch (behavior) {
    case "endpoint-independent":
      return base
    case "address-dependent":
      return `${base}>${remote.host}`
    case "address-and-port-dependent":
      return `${base}>${endpointKey(remote)}`
  }
}
