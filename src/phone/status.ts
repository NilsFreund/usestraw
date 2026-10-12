import type { ConnectError } from "./connect-error"
import type { Call, PhoneSnapshot } from "./types"

/**
 * `"connecting"` until the first registration, `"online"` while registered, `"reconnecting"` while
 * retrying after a failure, `"closed"` once closed or failed for good. With `register: false`,
 * answers to a SIP ping every minute stand in for the registration. This list is complete: a
 * phone that is offline but trying again is `"reconnecting"`.
 */
export type PhoneStatus = "connecting" | "online" | "reconnecting" | "closed"

export interface Status {
  readonly status: PhoneStatus
  readonly error: ConnectError | undefined
  readonly retryAt: number | undefined
  /** Resolves when the phone first goes online, and rejects if it fails before. */
  readonly started: Promise<void>
  update(next: "online" | "reconnecting", failure?: ConnectError, at?: number): void
  fail(failure: ConnectError): void
  close(failure?: ConnectError, reason?: unknown): void
}

export function createStatus(notify: () => void): Status {
  const starting = Promise.withResolvers<void>()
  let status: PhoneStatus = "connecting"
  let error: ConnectError | undefined
  let retryAt: number | undefined

  return {
    get status() {
      return status
    },
    get error() {
      return error
    },
    get retryAt() {
      return retryAt
    },
    started: starting.promise,
    update: (next, failure, at) => {
      const changed = next !== status || failure !== error || at !== retryAt
      status = next
      error = failure
      retryAt = at
      if (changed) notify()
      if (next === "online") starting.resolve()
      else starting.reject(failure)
    },
    fail: (failure) => {
      error = failure
      notify()
    },
    close: (failure, reason = failure) => {
      status = "closed"
      error = failure
      retryAt = undefined
      starting.reject(reason)
    },
  }
}

export function snapshotOf(state: Status, calls: readonly Call[]): PhoneSnapshot {
  const { status, error, retryAt } = state
  return Object.freeze({
    status,
    ...(error ? { error: Object.freeze({ reason: error.reason, message: error.message }) } : {}),
    ...(retryAt === undefined ? {} : { retryAt }),
    calls: Object.freeze(calls.map((call) => call.toJSON())),
  })
}
