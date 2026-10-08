import { parseMessage, type SipMessage } from "../src"

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

export function parsed(data: Uint8Array | string): SipMessage {
  const result = parseMessage(data)
  if (!result.ok) throw new Error(result.error)
  return result.message
}
