import type { SipMessage, SipRequest } from "../message/types"
import type { CallMedia } from "../sdp/types"
import type { TransactionEvent } from "../transaction/types"
import type { Address } from "../transport/address"

/** A number in `[0, 1)` like `Math.random`, but cryptographically secure. */
export type Random = () => number

/** The account to answer digest challenges (RFC 7616, RFC 8760) with. */
export interface Credentials {
  readonly username: string
  readonly password: string
  readonly realm?: string
}

/** What the app wants: register, call, accept, end, ping or send a raw message. */
export type Command =
  | {
      readonly type: "options"
      readonly uri: string
      readonly to: Address
      readonly callId?: string
    }
  | { readonly type: "send"; readonly message: SipMessage; readonly to: Address }
  | {
      readonly type: "register"
      readonly to: Address
      readonly registrar?: string
      readonly expires?: number
    }
  | { readonly type: "unregister" }
  | {
      readonly type: "call"
      readonly call: string
      readonly uri: string
      readonly to: Address
      readonly media: LocalMedia
    }
  | { readonly type: "accept"; readonly call: string; readonly media: LocalMedia }
  | { readonly type: "end"; readonly call: string; readonly status?: number }

/** Where this phone receives RTP. `host` defaults to the core's own address. */
export interface LocalMedia {
  readonly host?: string
  readonly port: number
}

export interface OfferedChallenge {
  readonly scheme: string
  readonly realm?: string
  readonly algorithm?: string
}

export type AuthFailure =
  | { readonly reason: "no-credentials" }
  | { readonly reason: "unsupported-challenge"; readonly offered: readonly OfferedChallenge[] }
  | { readonly reason: "unauthorized"; readonly status: number }

export type RegistrationFailure =
  | { readonly reason: "timeout" }
  | { readonly reason: "rejected"; readonly status: number; readonly phrase: string }
  | { readonly reason: "not-bound" }
  | AuthFailure

/** How the registration is doing; `retryIn` is in milliseconds. */
export type RegistrationEvent =
  | { readonly type: "registration"; readonly state: "registered"; readonly expires: number }
  | { readonly type: "registration"; readonly state: "unregistered" }
  | {
      readonly type: "registration"
      readonly state: "failed"
      readonly failure: RegistrationFailure
      readonly retryIn?: number
    }

/**
 * Why a call ended:
 *
 * - `"hangup"`: someone hung up a live call.
 * - `"cancelled"`: the caller gave up before the answer.
 * - `"busy"`: 486 or 600.
 * - `"declined"`: 603 or 607.
 * - `"not-found"`: no such number or user (404, 410, 484, 604).
 * - `"no-answer"`: nobody picked up in time (408, 480, or your `timeout`).
 * - `"unavailable"`: any 5xx.
 * - `"rejected"`: any other 4xx.
 * - `"unauthorized"`: the server refused our credentials for this call.
 * - `"incompatible"`: no codec in common (488, 606).
 * - `"timeout"`: the other side stopped responding, or the phone went offline.
 */
export type CallReason =
  | "hangup"
  | "cancelled"
  | "busy"
  | "declined"
  | "not-found"
  | "no-answer"
  | "unavailable"
  | "rejected"
  | "unauthorized"
  | "incompatible"
  | "timeout"

/** Who ended a call, why, and the SIP status if there was one. */
export interface CallEnd {
  readonly by: "local" | "remote"
  readonly reason: CallReason
  readonly status?: number
}

export interface CallParty {
  readonly uri: string
  readonly name?: string
}

/** A call changed state; `call` is its id, the SIP Call-ID. */
export type CallEvent =
  | {
      readonly type: "call"
      readonly call: string
      readonly state: "incoming"
      readonly from: CallParty
      readonly to: CallParty
      readonly source: Address
    }
  | {
      readonly type: "call"
      readonly call: string
      readonly state: "ringing"
      readonly status: number
      readonly media?: CallMedia
    }
  | {
      readonly type: "call"
      readonly call: string
      readonly state: "live"
      readonly media?: CallMedia
    }
  | {
      readonly type: "call"
      readonly call: string
      readonly state: "ended"
      readonly ended: CallEnd
    }

/** A received datagram, a passed deadline, or an app command. */
export type Input =
  | { readonly type: "receive"; readonly data: Uint8Array; readonly from: Address }
  | { readonly type: "timeout" }
  | { readonly type: "command"; readonly command: Command }

/** What the core reports: registration and call changes, requests, and invalid input. */
export type CoreEvent =
  | Exclude<TransactionEvent, { readonly type: "request" }>
  | { readonly type: "request"; readonly request: SipRequest; readonly from: Address }
  | {
      readonly type: "answered"
      readonly request: SipRequest
      readonly from: Address
      readonly status: number
    }
  | { readonly type: "invalid"; readonly error: string; readonly from: Address }
  | RegistrationEvent
  | CallEvent

/** Bytes to send, or an event for the app. */
export type Output =
  | { readonly type: "send"; readonly data: Uint8Array; readonly to: Address }
  | { readonly type: "event"; readonly event: CoreEvent }
