import type { CallReason } from "../types"

const NOT_FOUND: ReadonlySet<number> = new Set([404, 410, 484, 604])

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
