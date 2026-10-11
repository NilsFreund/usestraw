import { parseDeltaSeconds } from "../../message/fields/delta-seconds"
import { getHeader } from "../../message/headers"
import type { SipResponse } from "../../message/types"
import { backoff } from "../../support/backoff"
import type { Random, RegistrationFailure } from "../types"

const BASE = 30_000
const MAX = 1_800_000
const RETRYABLE: ReadonlySet<number> = new Set([408, 480, 500, 502, 503, 504])

export function isRetryable(failure: RegistrationFailure): boolean {
  if (failure.reason === "timeout") return true
  return failure.reason === "rejected" && RETRYABLE.has(failure.status)
}

// RFC 5626 §4.5: exponential backoff, and Retry-After may only make the wait longer
export function retryDelay(failures: number, random: Random, response?: SipResponse): number {
  const wait = backoff(failures, BASE, MAX, random)
  const seconds =
    response && parseDeltaSeconds(getHeader(response, "Retry-After")?.match(/^\d+/)?.[0])
  return Math.max(wait, Math.min(MAX, (seconds ?? 0) * 1000))
}
