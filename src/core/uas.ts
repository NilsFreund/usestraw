import { isSipUri } from "../message/fields/uri"
import { isToken, splitList } from "../message/syntax"
import type { Header, SipRequest } from "../message/types"

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

const ALLOW: Header = { name: "Allow", value: "ACK, CANCEL, OPTIONS" }
const ACCEPT_NOTHING: Header = { name: "Accept", value: "" }

export function answer(request: SipRequest): Answer {
  const { method } = request
  if (method === "CANCEL") return answerWith(481, "Call/Transaction Does Not Exist")
  if (!KNOWN_METHODS.has(method)) return answerWith(501, "Not Implemented")
  if (method !== "OPTIONS") return answerWith(405, "Method Not Allowed", [ALLOW])
  if (!isSipUri(request.uri)) return answerWith(416, "Unsupported URI Scheme")
  const required = requiredOptions(request)
  if (!required.every(isToken)) return answerWith(400, "Bad Request")
  if (required.length > 0) {
    return answerWith(420, "Bad Extension", [{ name: "Unsupported", value: required.join(", ") }])
  }
  if (request.body.length > 0) return answerWith(415, "Unsupported Media Type", [ACCEPT_NOTHING])
  return answerWith(200, "OK", [ALLOW])
}

function requiredOptions(request: SipRequest): string[] {
  return request.headers
    .filter((header) => header.name === "Require")
    .flatMap((header) => splitList(header.value))
}

function answerWith(status: number, reason: string, headers: readonly Header[] = []): Answer {
  return { status, reason, headers }
}
