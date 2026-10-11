import type { NameAddr } from "../../message/fields/name-addr"
import type { SipRequest, SipResponse } from "../../message/types"
import type { TransactionEvent } from "../../transaction/types"
import type { TransportAddress } from "../../transport/address"
import type { RegistrationEvent } from "../types"

export interface RegisterIntent {
  readonly to: TransportAddress
  readonly registrar: string
  readonly expires: number
}

export type RegistrationOutput =
  | { readonly type: "send"; readonly request: SipRequest; readonly to: TransportAddress }
  | { readonly type: "event"; readonly event: RegistrationEvent }

export type RegistrationInput = Extract<TransactionEvent, { readonly type: "response" | "timeout" }>

export interface Registration {
  readonly contact: NameAddr
  register(intent: RegisterIntent): RegistrationOutput[]
  unregister(): RegistrationOutput[]
  receive(input: RegistrationInput, now: number): RegistrationOutput[]
  observe(response: SipResponse): void
  expire(now: number): RegistrationOutput[]
  nextDeadline(): number | undefined
}
