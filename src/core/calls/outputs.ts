import type { SipRequest, SipResponse } from "../../message/types"
import type { Address } from "../../transport/address"
import type { CallEvent } from "../types"
import type { CallOutput } from "./types"

export function send(request: SipRequest, to: Address): CallOutput {
  return { type: "send", request, to }
}

export function respond(transaction: string, response: SipResponse): CallOutput {
  return { type: "respond", transaction, response }
}

export function emit(event: CallEvent): CallOutput {
  return { type: "event", event }
}
