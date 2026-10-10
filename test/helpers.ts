import { readFileSync } from "node:fs"
import {
  type Address,
  type Command,
  type Core,
  type CoreEvent,
  createCore,
  isRequest,
  parseMessage,
  type Random,
  type SipMessage,
  type SipRequest,
} from "../src"

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

export function parsedRequest(data: Uint8Array | string): SipRequest {
  const message = parsed(data)
  if (!isRequest(message)) throw new Error("Expected a request")
  return message
}

export function eventTypes(events: readonly CoreEvent[]): string[] {
  return events.map((event) => event.type)
}

export function outcomes(events: readonly CoreEvent[]): string[] {
  return eventTypes(events).filter((type) => type === "response" || type === "timeout")
}

export function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function samples(maxLength: number): Uint8Array[] {
  return Array.from({ length: maxLength + 1 }, (_, length) =>
    Uint8Array.from({ length }, (_, index) => (index * 131 + length) & 255),
  )
}

export function userAgent(user: string, address: Address): (random: Random) => Core {
  return (random) => createCore({ address, aor: `sip:${user}@example.com`, random })
}

export function options(to: Address, uri = "sip:bob@example.com"): Command {
  return { type: "options", uri, to }
}

export interface SdpOptions {
  readonly host?: string
  readonly port?: number
  readonly formats?: readonly number[]
  readonly direction?: string
  readonly version?: number
  readonly extra?: readonly string[]
}

const NAMES: Readonly<Record<number, string>> = {
  0: "PCMU/8000",
  8: "PCMA/8000",
  18: "G729/8000",
  101: "telephone-event/8000",
}

export function sdp(options: SdpOptions = {}): string {
  const { host = "192.0.2.20", port = 4000, formats = [0, 8, 101], version = 1 } = options
  const { direction, extra = [] } = options
  return [
    "v=0",
    `o=bob 1 ${version} IN IP4 ${host}`,
    "s=-",
    `c=IN IP4 ${host}`,
    "t=0 0",
    `m=audio ${port} RTP/AVP ${formats.join(" ")}`,
    ...formats.map((format) => `a=rtpmap:${format} ${NAMES[format] ?? "X/8000"}`),
    ...(formats.includes(101) ? ["a=fmtp:101 0-16"] : []),
    ...(direction === undefined ? [] : [`a=${direction}`]),
    ...extra,
    "",
  ].join("\r\n")
}

export const aliceMedia = { host: "192.0.2.10", port: 40_000 } as const
