import { isPort, isSocketHost } from "../message/fields/host"

const TRANSPORTS = ["UDP", "TCP", "TLS", "WS", "WSS"] as const

/** How SIP travels; Straw itself speaks UDP, TLS and WebSocket. */
export type TransportProtocol = (typeof TRANSPORTS)[number]

/** A socket address: where to send SIP, or where it came from. */
export interface TransportAddress {
  readonly transport: TransportProtocol
  readonly host: string
  readonly port: number
}

export function isAddress(address: TransportAddress): boolean {
  const { transport, host, port } = address
  return TRANSPORTS.includes(transport) && isSocketHost(host) && isPort(port)
}

export function isReliable(address: TransportAddress): boolean {
  return address.transport !== "UDP"
}

export function isWebSocket(transport: TransportProtocol): boolean {
  return transport === "WS" || transport === "WSS"
}

// RFC 7118 Appendix B.1: a WebSocket client has no port anyone could reach, so Via and Contact name none
export function sentByPort(address: TransportAddress): number | undefined {
  return isWebSocket(address.transport) ? undefined : address.port
}

export function defaultPort(transport: string): number {
  return transport.toUpperCase() === "TLS" ? 5061 : 5060
}
