import type { SipMessage, SipRequest, SipResponse } from "../message/types"
import type { TransportAddress } from "../transport/address"

export type TransactionEvent =
  | {
      readonly type: "request"
      readonly request: SipRequest
      readonly from: TransportAddress
      readonly transaction?: string
    }
  | { readonly type: "response"; readonly response: SipResponse; readonly from: TransportAddress }
  | { readonly type: "stray"; readonly response: SipResponse; readonly from: TransportAddress }
  | { readonly type: "timeout"; readonly request: SipRequest }
  | {
      readonly type: "unacknowledged"
      readonly request: SipRequest
      readonly response: SipResponse
    }

export type TransactionOutput =
  | { readonly type: "send"; readonly message: SipMessage; readonly to: TransportAddress }
  | { readonly type: "event"; readonly event: TransactionEvent }

export interface Transaction<State extends string> {
  readonly key: string
  readonly state: State
  start(now: number): TransactionOutput[]
  nextDeadline(): number | undefined
  expire(now: number): TransactionOutput[]
}

export interface ClientTransaction<State extends string = string> extends Transaction<State> {
  receive(response: SipResponse, from: TransportAddress, now: number): TransactionOutput[]
}

export interface ServerTransaction<State extends string = string> extends Transaction<State> {
  receive(request: SipRequest, to: TransportAddress, now: number): TransactionOutput[]
  respond(response: SipResponse, now: number): TransactionOutput[]
}
