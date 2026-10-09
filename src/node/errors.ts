import type { OfferedChallenge, RegistrationFailure } from "../core/types"
import { show } from "../message/syntax"

export type PhoneFailure = RegistrationFailure | { readonly reason: "network" }

export interface ErrorContext {
  readonly label: string
  readonly username: string
}

const UNTRUSTED = /SELF_SIGNED|UNABLE_TO_(?:GET|VERIFY)/

export class RegistrationError extends Error {
  override readonly name = "RegistrationError"
  readonly failure: PhoneFailure

  constructor(failure: PhoneFailure, context: ErrorContext, cause?: Error) {
    super(explain(failure, context, cause), cause && { cause })
    this.failure = failure
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
      return `${server} accepted the registration but kept no binding`
    case "no-credentials":
      return `${server} asks for a password, but none was given`
    case "unsupported-challenge":
      return `${server} asks for authentication Straw does not support: ${describe(failure.offered)}`
    case "unauthorized":
      return `${server} refused the password for ${show(username)} with ${failure.status}: check the password, or pass username if your provider uses a separate auth user`
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
