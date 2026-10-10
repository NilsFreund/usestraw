import { isRetryable } from "../core/registration/retry"
import type { OfferedChallenge, RegistrationFailure } from "../core/types"
import { show } from "../message/syntax"

export type PhoneFailure = RegistrationFailure | { readonly reason: "network" }

/**
 * - `"wrong-password"`: credentials refused.
 * - `"password-missing"`: the server wants a password.
 * - `"unsupported-auth"`: the server wants auth that Straw doesn't speak.
 * - `"refused"`: registration denied for good, e.g. 403.
 * - `"unavailable"`: the server can't register you right now, e.g. 503.
 * - `"no-answer"`: no response. Check host, port and transport.
 * - `"network"`: the connection failed or broke.
 */
export type ConnectReason =
  | "wrong-password"
  | "password-missing"
  | "unsupported-auth"
  | "refused"
  | "unavailable"
  | "no-answer"
  | "network"

/** Constructor options for {@link ConnectError}. */
export interface ConnectErrorOptions {
  readonly reason: ConnectReason
  readonly sip?: { readonly status: number } | undefined
  readonly cause?: unknown
}

export interface ErrorContext {
  readonly label: string
  readonly username: string
}

const UNTRUSTED = /SELF_SIGNED|UNABLE_TO_(?:GET|VERIFY)/

/**
 * Why a phone couldn't connect, or why it's reconnecting or offline. Show `message` to people,
 * switch on `reason` in code.
 *
 * @example
 * ```ts
 * try {
 *   await connect(process.env.SIP_URL)
 * } catch (error) {
 *   if (error instanceof ConnectError && error.reason === "wrong-password") askForPassword()
 *   else throw error
 * }
 * ```
 */
export class ConnectError extends Error {
  override readonly name = "ConnectError"
  readonly reason: ConnectReason
  /** The server's SIP status, e.g. `{ status: 403 }`, if it sent one. */
  readonly sip: { readonly status: number } | undefined

  constructor(message: string, options: ConnectErrorOptions) {
    super(message, "cause" in options ? { cause: options.cause } : undefined)
    this.reason = options.reason
    this.sip = options.sip
  }
}

export function connectError(
  failure: PhoneFailure,
  context: ErrorContext,
  cause?: Error,
): ConnectError {
  const status = "status" in failure ? failure.status : undefined
  return new ConnectError(explain(failure, context, cause), {
    reason: reasonOf(failure),
    sip: status === undefined ? undefined : { status },
    ...(cause ? { cause } : {}),
  })
}

function reasonOf(failure: PhoneFailure): ConnectReason {
  switch (failure.reason) {
    case "unauthorized":
      return "wrong-password"
    case "no-credentials":
      return "password-missing"
    case "unsupported-challenge":
      return "unsupported-auth"
    case "rejected":
      return isRetryable(failure) ? "unavailable" : "refused"
    case "not-bound":
      return "refused"
    case "timeout":
      return "no-answer"
    case "network":
      return "network"
  }
}

function explain(failure: PhoneFailure, context: ErrorContext, cause?: Error): string {
  const { label: server, username } = context
  switch (failure.reason) {
    case "timeout":
      return `No answer from ${server}: check the host, port and transport`
    case "rejected":
      return `${server} rejected the registration with ${failure.status} ${show(failure.phrase)}`
    case "not-bound":
      return `${server} accepted the registration but did not keep it: a NAT or SIP ALG may have rewritten our address`
    case "no-credentials":
      return `${server} asks for a password, but none was given`
    case "unsupported-challenge":
      return `${server} asks for authentication Straw does not support: ${describe(failure.offered)}`
    case "unauthorized":
      return `${server} refused the password for ${show(username)} with ${failure.status}: check the password, or pass authUser if your provider uses a separate auth user`
    case "network":
      return `Network error with ${server}: ${detail(cause)}`
  }
}

function describe(offered: readonly OfferedChallenge[]): string {
  if (offered.length === 0) return "no challenge"
  const shown = offered
    .slice(0, 3)
    .map(({ scheme, algorithm }) =>
      show(algorithm === undefined ? scheme : `${scheme} ${algorithm}`),
    )
  return [...shown, ...(offered.length > 3 ? ["…"] : [])].join(", ")
}

function detail(cause: Error | undefined): string {
  if (!cause) return "the server closed the connection"
  const code = (cause as NodeJS.ErrnoException).code ?? ""
  const hint = UNTRUSTED.test(code) ? " (pass tls.ca if the server uses a private CA)" : ""
  return `${cause.message}${hint}`
}
