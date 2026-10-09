import { isSipUri } from "../message/fields/uri"
import type { Header, SipRequest } from "../message/types"

export interface Answer {
  readonly status: number
  readonly reason: string
  readonly headers: readonly Header[]
}

const ALLOW: Header = { name: "Allow", value: "OPTIONS" }

export interface Situation {
  readonly cancelsInvite: boolean
}

export function answer(request: SipRequest, situation: Situation): Answer {
  if (request.method === "CANCEL") {
    if (situation.cancelsInvite) return { status: 200, reason: "OK", headers: [] }
    return { status: 481, reason: "Call/Transaction Does Not Exist", headers: [] }
  }
  if (request.method !== "OPTIONS") {
    return { status: 405, reason: "Method Not Allowed", headers: [ALLOW] }
  }
  if (!isSipUri(request.uri)) {
    return { status: 416, reason: "Unsupported URI Scheme", headers: [] }
  }
  const required = request.headers
    .filter((header) => header.name === "Require")
    .flatMap((header) => header.value.split(","))
    .map((option) => option.trim())
    .filter((option) => option !== "")
  if (required.length > 0) {
    const unsupported = { name: "Unsupported", value: required.join(", ") }
    return { status: 420, reason: "Bad Extension", headers: [unsupported] }
  }
  return { status: 200, reason: "OK", headers: [ALLOW] }
}
