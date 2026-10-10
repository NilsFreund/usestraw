import type { NameAddr } from "../../message/fields/name-addr"
import { getHeaders } from "../../message/headers"
import { createResponse } from "../../message/response"
import type { SipHeader, SipRequest, SipResponse } from "../../message/types"
import { ALLOW } from "../requests"
import type { Random } from "../types"
import { SDP } from "./requests"

export interface ReplyFields {
  readonly tag?: string
  readonly contact?: NameAddr
  readonly sdp?: Uint8Array
  readonly headers?: readonly SipHeader[]
  readonly recordRoute?: boolean
}

const PHRASES: Readonly<Record<number, string>> = {
  180: "Ringing",
  200: "OK",
  403: "Forbidden",
  404: "Not Found",
  480: "Temporarily Unavailable",
  481: "Call/Transaction Does Not Exist",
  482: "Loop Detected",
  486: "Busy Here",
  487: "Request Terminated",
  488: "Not Acceptable Here",
  500: "Server Internal Error",
  503: "Service Unavailable",
  600: "Busy Everywhere",
  603: "Decline",
}

// RFC 3261 §20.43: warning 305 names a media mismatch in a 488
export const INCOMPATIBLE_MEDIA: SipHeader = {
  name: "Warning",
  value: '305 straw "Incompatible media format"',
}

export function phraseFor(status: number): string {
  return PHRASES[status] ?? "Rejected"
}

// RFC 3261 §12.1.1: responses that create a dialog copy Record-Route and carry our Contact
export function createReply(
  request: SipRequest,
  status: number,
  fields: ReplyFields = {},
): SipResponse {
  const { tag, contact, sdp, headers = [], recordRoute = false } = fields
  const routes = recordRoute
    ? getHeaders(request, "Record-Route").map((value) => ({ name: "Record-Route", value }))
    : []
  const response = createResponse(request, status, phraseFor(status), {
    ...(tag === undefined ? {} : { toTag: tag }),
    headers: [...routes, ...headers, ...(contact ? [ALLOW] : []), ...(sdp ? [SDP] : [])],
  })
  return { ...response, contact: contact ? [contact] : [], ...(sdp ? { body: sdp } : {}) }
}

// RFC 3261 §14.2: a second INVITE before the first one completes gets a 500 with a random Retry-After
export function createRetryLater(request: SipRequest, random: Random): SipResponse {
  const seconds = Math.min(10, Math.floor(random() * 11))
  return createReply(request, 500, { headers: [{ name: "Retry-After", value: String(seconds) }] })
}
