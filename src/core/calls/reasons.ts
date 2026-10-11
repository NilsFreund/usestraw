import { getHeaders } from "../../message/headers"
import { QUOTED_STRING } from "../../message/syntax"
import type { SipRequest } from "../../message/types"
import type { CallReason } from "../types"

const NOT_FOUND: ReadonlySet<number> = new Set([404, 410, 484, 604])
const QUOTED = new RegExp(QUOTED_STRING, "g")
const CAUSE_200 = /^cause\s*=\s*200$/i

export function reasonFor(status: number): CallReason {
  if (status === 486 || status === 600) return "busy"
  if (status === 603 || status === 607) return "declined"
  if (NOT_FOUND.has(status)) return "not-found"
  if (status === 408 || status === 480) return "no-answer"
  if (status === 487) return "cancelled"
  if (status === 488 || status === 606) return "incompatible"
  if (status >= 500 && status < 600) return "unavailable"
  return "rejected"
}

// RFC 3326: a CANCEL with Reason: SIP;cause=200 means another device took the call
export function cancelReason(cancel: SipRequest): CallReason {
  return getHeaders(cancel, "Reason").some(answeredElsewhere) ? "answered-elsewhere" : "cancelled"
}

// Quoted texts may hold commas and semicolons, so they go first; a quote left open spoils it all
function answeredElsewhere(value: string): boolean {
  const bare = value.replace(QUOTED, '""')
  if (bare.replaceAll('""', "").includes('"')) return false
  return bare.split(",").some((reason) => {
    const [protocol, ...params] = reason.split(";").map((part) => part.trim())
    return protocol?.toUpperCase() === "SIP" && params.some((param) => CAUSE_200.test(param))
  })
}
