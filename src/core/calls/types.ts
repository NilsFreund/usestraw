import type { NameAddr } from "../../message/fields/name-addr"
import type { SipRequest, SipResponse } from "../../message/types"
import type { MediaAddress } from "../../sdp/types"
import type { TimerSettings } from "../../transaction/timers"
import type { TransportAddress } from "../../transport/address"
import type { Identity } from "../requests"
import type { CallEvent, Credentials } from "../types"

export type CallOutput =
  | { readonly type: "send"; readonly request: SipRequest; readonly to: TransportAddress }
  | { readonly type: "respond"; readonly transaction: string; readonly response: SipResponse }
  | { readonly type: "abandon"; readonly request: SipRequest }
  | { readonly type: "event"; readonly event: CallEvent }

export interface CallContext {
  readonly identity: Identity
  readonly contact: NameAddr
  readonly credentials: Credentials | undefined
  readonly timers: TimerSettings
}

export interface Call {
  readonly ended: boolean
  readonly deadline: number | undefined
  start(): CallOutput[]
  accept(media: MediaAddress, now: number): CallOutput[]
  end(now: number, status?: number): CallOutput[]
  response(response: SipResponse, now: number): CallOutput[]
  timeout(request: SipRequest): CallOutput[]
  matches(request: SipRequest): boolean
  merges(invite: SipRequest): boolean
  request(request: SipRequest, transaction: string, now: number): CallOutput[]
  acknowledge(ack: SipRequest): CallOutput[]
  expire(now: number): CallOutput[]
}
