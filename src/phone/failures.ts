import { isRetryable } from "../core/registration/retry"
import type { AuthChallenge, RegistrationFailure } from "../core/types"
import { show } from "../message/syntax"
import { ConnectError, type ConnectReason } from "./connect-error"

export type PhoneFailure = RegistrationFailure | { readonly reason: "network" }

export interface ErrorContext {
  readonly label: string
  readonly username: string
  readonly realm?: string | undefined
}

const UNTRUSTED = /SELF_SIGNED|UNABLE_TO_(?:GET|VERIFY)/

export function toConnectError(
  failure: PhoneFailure,
  context: ErrorContext,
  cause?: unknown,
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

function explain(failure: PhoneFailure, context: ErrorContext, cause?: unknown): string {
  const { label: server, username, realm } = context
  switch (failure.reason) {
    case "timeout":
      return `No answer from ${server}: check the host, port and transport`
    case "rejected": {
      const rejected = `${server} rejected the registration with ${failure.status} ${show(failure.phrase)}`
      // Some servers answer a wrong password with 403 instead of another challenge
      return failure.status === 403 && failure.withCredentials
        ? `${rejected}: check the password and authUser`
        : rejected
    }
    case "not-bound":
      return `${server} accepted the registration but did not keep it: a NAT or SIP ALG may have rewritten our address`
    case "no-credentials":
      return `${server} asks for a password, but none was given`
    case "unsupported-challenge": {
      const named = realmsOf(failure.offered)
      if (realm !== undefined && named.length > 0 && !named.includes(realm)) {
        return `${server} asks for authentication in realm ${list(named)}, not ${show(realm)}: check realm`
      }
      return `${server} asks for authentication Straw does not support: ${describe(failure.offered)}`
    }
    case "unauthorized":
      return `${server} refused the password for ${show(username)} with ${failure.status}: check the password, or pass authUser if your provider uses a separate auth user`
    case "network":
      return `Network error with ${server}: ${detail(cause)}`
  }
}

function describe(offered: readonly AuthChallenge[]): string {
  if (offered.length === 0) return "no challenge"
  return list(
    offered.map(({ scheme, algorithm }) =>
      algorithm === undefined ? scheme : `${scheme} ${algorithm}`,
    ),
  )
}

function realmsOf(offered: readonly AuthChallenge[]): string[] {
  return [...new Set(offered.flatMap((offer) => (offer.realm === undefined ? [] : [offer.realm])))]
}

function list(names: readonly string[]): string {
  return [...names.slice(0, 3).map(show), ...(names.length > 3 ? ["…"] : [])].join(", ")
}

function detail(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause ?? "") || "the server closed the connection"
  const code = "code" in cause ? String(cause.code) : ""
  const hint = UNTRUSTED.test(code) ? " (pass tls.ca if the server uses a private CA)" : ""
  return `${cause.message}${hint}`
}
