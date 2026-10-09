import type { Address } from "../../transport/address"

export function addressKey(address: Address): string {
  return `${address.transport}:${address.host}:${address.port}`
}

export function sameAddress(a: Address, b: Address): boolean {
  return addressKey(a) === addressKey(b)
}
