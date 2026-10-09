import type { Address } from "../../../transport/address"
import type { NatBehavior } from "./types"

export function endpointKey(address: Address): string {
  return `${address.host}:${address.port}`
}

export function portKey(transport: string, port: number): string {
  return `${transport}:${port}`
}

export function mappingKey(behavior: NatBehavior, internal: Address, remote: Address): string {
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
