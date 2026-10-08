import { readFileSync } from "node:fs"
import { type Address, type CoreEvent, parseMessage, type SipMessage } from "../src"

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`fixtures/rfc4475/${name}.dat`, import.meta.url)))
}

export const register: string = [
  "REGISTER sip:example.com SIP/2.0",
  "Via: SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bK776asdhds;rport",
  "Max-Forwards: 70",
  "To: Bob <sip:bob@example.com>",
  "From: Bob <sip:bob@example.com>;tag=456248",
  "Call-ID: 843817637684230@998sdasdh09",
  "CSeq: 1826 REGISTER",
  "Contact: <sip:bob@192.0.2.4>;expires=7200",
  "Supported: path, outbound",
  "Content-Length: 0",
  "",
  "",
].join("\r\n")

export const alice: Address = { transport: "UDP", host: "192.0.2.10", port: 5060 }
export const bob: Address = { transport: "UDP", host: "192.0.2.20", port: 5060 }

export function parsed(data: Uint8Array | string): SipMessage {
  const result = parseMessage(data)
  if (!result.ok) throw new Error(result.error)
  return result.message
}

export function eventTypes(events: readonly CoreEvent[]): string[] {
  return events.map((event) => event.type)
}

export function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}
