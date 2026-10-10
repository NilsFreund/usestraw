import { formatContact } from "./fields/contact"
import { formatCSeq } from "./fields/cseq"
import { formatNameAddr } from "./fields/name-addr"
import { formatVia } from "./fields/via"
import type { SipHeader, SipMessage } from "./types"

const KNOWN = [
  "Accept",
  "Accept-Contact",
  "Accept-Encoding",
  "Accept-Language",
  "Alert-Info",
  "Allow",
  "Allow-Events",
  "Authentication-Info",
  "Authorization",
  "Call-ID",
  "Call-Info",
  "Contact",
  "Content-Disposition",
  "Content-Encoding",
  "Content-Language",
  "Content-Length",
  "Content-Type",
  "CSeq",
  "Date",
  "Error-Info",
  "Event",
  "Expires",
  "From",
  "Identity",
  "Identity-Info",
  "In-Reply-To",
  "Max-Forwards",
  "MIME-Version",
  "Min-Expires",
  "Min-SE",
  "Organization",
  "P-Asserted-Identity",
  "P-Preferred-Identity",
  "Path",
  "Priority",
  "Privacy",
  "Proxy-Authenticate",
  "Proxy-Authorization",
  "Proxy-Require",
  "RAck",
  "Reason",
  "Record-Route",
  "Refer-To",
  "Referred-By",
  "Reject-Contact",
  "Reply-To",
  "Request-Disposition",
  "Require",
  "Retry-After",
  "Route",
  "RSeq",
  "Server",
  "Service-Route",
  "Session-Expires",
  "Subject",
  "Subscription-State",
  "Supported",
  "Timestamp",
  "To",
  "Unsupported",
  "User-Agent",
  "Via",
  "Warning",
  "WWW-Authenticate",
]

const COMPACT = {
  a: "Accept-Contact",
  b: "Referred-By",
  c: "Content-Type",
  d: "Request-Disposition",
  e: "Content-Encoding",
  f: "From",
  i: "Call-ID",
  j: "Reject-Contact",
  k: "Supported",
  l: "Content-Length",
  m: "Contact",
  n: "Identity-Info",
  o: "Event",
  r: "Refer-To",
  s: "Subject",
  t: "To",
  u: "Allow-Events",
  v: "Via",
  x: "Session-Expires",
  y: "Identity",
}

const CANONICAL = new Map<string, string>([
  ...KNOWN.map((name): [string, string] => [name.toLowerCase(), name]),
  ...Object.entries(COMPACT),
])

const TYPED = new Set([
  "Via",
  "Max-Forwards",
  "From",
  "To",
  "Call-ID",
  "CSeq",
  "Contact",
  "Content-Length",
])

export function canonicalName(name: string): string {
  return CANONICAL.get(name.toLowerCase()) ?? name
}

export function isTypedHeader(name: string): boolean {
  return TYPED.has(canonicalName(name))
}

export function headerList(message: SipMessage): SipHeader[] {
  return [
    ...message.via.map((via) => ({ name: "Via", value: formatVia(via) })),
    ...(message.maxForwards === undefined
      ? []
      : [{ name: "Max-Forwards", value: String(message.maxForwards) }]),
    { name: "From", value: formatNameAddr(message.from) },
    { name: "To", value: formatNameAddr(message.to) },
    { name: "Call-ID", value: message.callId },
    { name: "CSeq", value: formatCSeq(message.cseq) },
    ...formatContact(message.contact).map((value) => ({ name: "Contact", value })),
    ...message.headers,
    { name: "Content-Length", value: String(message.body.length) },
  ]
}

/** All values of a header, in order. Compact names like `v` for `Via` work. */
export function getHeaders(message: SipMessage, name: string): string[] {
  const wanted = canonicalName(name).toLowerCase()
  return headerList(message)
    .filter((header) => header.name.toLowerCase() === wanted)
    .map((header) => header.value)
}

/** The first value of a header, or `undefined`. */
export function getHeader(message: SipMessage, name: string): string | undefined {
  return getHeaders(message, name)[0]
}
