/**
 * - `"wrong-password"`: credentials refused.
 * - `"password-missing"`: the server wants a password.
 * - `"unsupported-auth"`: the server wants auth that Straw doesn't speak, or a realm other than `realm`.
 * - `"refused"`: registration denied for good, e.g. 403.
 * - `"unavailable"`: the server can't register you right now, e.g. 503.
 * - `"no-answer"`: no response. Check host, port and transport.
 * - `"network"`: the connection failed or broke.
 *
 * New reasons may come in minor versions, so keep a default branch when you switch on them.
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

/**
 * Why a phone couldn't connect, or why it's reconnecting or closed. Show `message` to people,
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
