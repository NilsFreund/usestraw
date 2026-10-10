import type { TransportAddress } from "../../transport/address"

export function addressKey(address: TransportAddress): string {
  return `${address.transport}:${address.host}:${address.port}`
}

export function sameAddress(a: TransportAddress, b: TransportAddress): boolean {
  return addressKey(a) === addressKey(b)
}
