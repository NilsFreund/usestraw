import type { SipRequest } from "../../message/types"
import type { TransactionEvent } from "../../transaction/types"
import type { Address } from "../../transport/address"
import type { RegistrationEvent } from "../types"

export interface RegisterIntent {
  readonly to: Address
  readonly registrar: string
  readonly expires: number
}

export type RegistrationOutput =
  | { readonly type: "send"; readonly request: SipRequest; readonly to: Address }
  | { readonly type: "event"; readonly event: RegistrationEvent }

export type RegistrationInput = Extract<TransactionEvent, { readonly type: "response" | "timeout" }>

export interface Registration {
  register(intent: RegisterIntent): RegistrationOutput[]
  unregister(): RegistrationOutput[]
  receive(input: RegistrationInput, now: number): RegistrationOutput[]
  expire(now: number): RegistrationOutput[]
  nextDeadline(): number | undefined
}
