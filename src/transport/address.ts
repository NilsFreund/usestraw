import { isPort, isSocketHost } from "../message/fields/host"

const TRANSPORTS = ["UDP", "TCP", "TLS", "WS", "WSS"] as const

export type Transport = (typeof TRANSPORTS)[number]

export interface Address {
  readonly transport: Transport
  readonly host: string
  readonly port: number
}

export function isAddress(address: Address): boolean {
  const { transport, host, port } = address
  return TRANSPORTS.includes(transport) && isSocketHost(host) && isPort(port)
}

export function isReliable(address: Address): boolean {
  return address.transport !== "UDP"
}

export function defaultPort(transport: string): number {
  return transport.toUpperCase() === "TLS" ? 5061 : 5060
}
