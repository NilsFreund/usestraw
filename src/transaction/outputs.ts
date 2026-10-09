import type { SipMessage } from "../message/types"
import type { Address } from "../transport/address"
import type { TransactionEvent, TransactionOutput } from "./types"

export function send(message: SipMessage, to: Address): TransactionOutput {
  return { type: "send", message, to }
}

export function notify(event: TransactionEvent): TransactionOutput {
  return { type: "event", event }
}
