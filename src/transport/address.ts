export type Transport = "UDP" | "TCP" | "TLS" | "WS" | "WSS"

export interface Address {
  readonly transport: Transport
  readonly host: string
  readonly port: number
}

export function isReliable(address: Address): boolean {
  return address.transport !== "UDP"
}

export function defaultPort(transport: string): number {
  return transport.toUpperCase() === "TLS" ? 5061 : 5060
}
