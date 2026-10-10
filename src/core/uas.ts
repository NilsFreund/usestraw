import { isSipUri } from "../message/fields/uri"
import { getHeader } from "../message/headers"
import { isToken, splitList } from "../message/syntax"
import type { Header, SipRequest } from "../message/types"
import { ALLOW } from "./requests"

export interface Answer {
  readonly status: number
  readonly reason: string
  readonly headers: readonly Header[]
}

const KNOWN_METHODS: ReadonlySet<string> = new Set([
  "ACK",
  "BYE",
  "CANCEL",
  "INFO",
  "INVITE",
  "MESSAGE",
  "NOTIFY",
  "OPTIONS",
  "PRACK",
  "PUBLISH",
  "REFER",
  "REGISTER",
  "SUBSCRIBE",
  "UPDATE",
])

const ACCEPT_NOTHING: Header = { name: "Accept", value: "" }
const ACCEPT_SDP: Header = { name: "Accept", value: "application/sdp" }
const SDP_TYPE = /^\s*application\/sdp\s*(?:;|$)/i
const IN_DIALOG = new Set(["BYE", "CANCEL", "INVITE"])

// Requests that reach this point belong to no call, so in-dialog methods get 481
export function answer(request: SipRequest): Answer {
  const { method } = request
  if (IN_DIALOG.has(method)) return answerWith(481, "Call/Transaction Does Not Exist")
  if (!KNOWN_METHODS.has(method)) return answerWith(501, "Not Implemented")
  if (method !== "OPTIONS") return answerWith(405, "Method Not Allowed", [ALLOW])
  const refusal = refuse(request)
  if (refusal) return refusal
  if (request.body.length > 0) return answerWith(415, "Unsupported Media Type", [ACCEPT_NOTHING])
  return answerWith(200, "OK", [ALLOW, ACCEPT_SDP])
}

// RFC 3261 §8.2.3: an INVITE whose body is not SDP cannot be answered
export function checkInvite(request: SipRequest): Answer | undefined {
  const refusal = refuse(request)
  if (refusal) return refusal
  const type = getHeader(request, "Content-Type") ?? ""
  if (request.body.length > 0 && !SDP_TYPE.test(type)) {
    return answerWith(415, "Unsupported Media Type", [ACCEPT_SDP])
  }
  return undefined
}

// RFC 3261 §8.2.2: unknown URI schemes and required extensions we lack are refused
function refuse(request: SipRequest): Answer | undefined {
  if (!isSipUri(request.uri)) return answerWith(416, "Unsupported URI Scheme")
  const required = requiredOptions(request)
  if (!required.every(isToken)) return answerWith(400, "Bad Request")
  if (required.length > 0) {
    return answerWith(420, "Bad Extension", [{ name: "Unsupported", value: required.join(", ") }])
  }
  return undefined
}

function requiredOptions(request: SipRequest): string[] {
  return request.headers
    .filter((header) => header.name === "Require")
    .flatMap((header) => splitList(header.value))
}

export function answerWith(
  status: number,
  reason: string,
  headers: readonly Header[] = [],
): Answer {
  return { status, reason, headers }
}
