import type { NameAddr } from "../../message/fields/name-addr"
import { getHeaders } from "../../message/headers"
import { phraseFor } from "../../message/phrases"
import { createResponse } from "../../message/response"
import type { SipHeader, SipRequest, SipResponse } from "../../message/types"
import { type Random, randomInt } from "../../support/random"
import { ALLOW } from "../requests"
import { SDP_CONTENT } from "./requests"

export interface ReplyFields {
  readonly tag?: string
  readonly contact?: NameAddr
  readonly sdp?: Uint8Array
  readonly headers?: readonly SipHeader[]
  readonly recordRoute?: boolean
}

// RFC 3261 §20.43: warning 305 names a media mismatch in a 488
export const INCOMPATIBLE_MEDIA: SipHeader = {
  name: "Warning",
  value: '305 straw "Incompatible media format"',
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
    headers: [...routes, ...headers, ...(contact ? [ALLOW] : []), ...(sdp ? [SDP_CONTENT] : [])],
  })
  return { ...response, contact: contact ? [contact] : [], ...(sdp ? { body: sdp } : {}) }
}

// RFC 3261 §14.2: a second INVITE before the first one completes gets a 500 with a random Retry-After
export function createRetryLater(request: SipRequest, random: Random): SipResponse {
  const seconds = randomInt(random, 11)
  return createReply(request, 500, { headers: [{ name: "Retry-After", value: String(seconds) }] })
}
