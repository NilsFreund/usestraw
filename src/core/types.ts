import type { SipMessage, SipRequest } from "../message/types"
import type { TransactionEvent } from "../transaction/types"
import type { Address } from "../transport/address"

export type Random = () => number

export interface Credentials {
  readonly username: string
  readonly password: string
  readonly realm?: string
}

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
      readonly sdp: Uint8Array
    }
  | { readonly type: "accept"; readonly call: string; readonly sdp: Uint8Array }
  | { readonly type: "end"; readonly call: string; readonly status?: number }

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

export type RegistrationEvent =
  | { readonly type: "registration"; readonly state: "registered"; readonly expires: number }
  | { readonly type: "registration"; readonly state: "unregistered" }
  | {
      readonly type: "registration"
      readonly state: "failed"
      readonly failure: RegistrationFailure
      readonly retryIn?: number
    }

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
  | "timeout"

export interface CallEnd {
  readonly by: "local" | "remote"
  readonly reason: CallReason
  readonly status?: number
}

export interface CallParty {
  readonly uri: string
  readonly name?: string
}

export type CallEvent =
  | {
      readonly type: "call"
      readonly call: string
      readonly state: "incoming"
      readonly from: CallParty
      readonly to: CallParty
      readonly source: Address
      readonly sdp?: Uint8Array
    }
  | {
      readonly type: "call"
      readonly call: string
      readonly state: "ringing"
      readonly status: number
      readonly sdp?: Uint8Array
    }
  | {
      readonly type: "call"
      readonly call: string
      readonly state: "live"
      readonly sdp?: Uint8Array
    }
  | {
      readonly type: "call"
      readonly call: string
      readonly state: "ended"
      readonly ended: CallEnd
    }

export type Input =
  | { readonly type: "receive"; readonly data: Uint8Array; readonly from: Address }
  | { readonly type: "timeout" }
  | { readonly type: "command"; readonly command: Command }

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

export type Output =
  | { readonly type: "send"; readonly data: Uint8Array; readonly to: Address }
  | { readonly type: "event"; readonly event: CoreEvent }
