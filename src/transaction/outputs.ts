import type { SipMessage } from "../message/types"
import type { TransportAddress } from "../transport/address"
import type { TransactionEvent, TransactionOutput } from "./types"

export function send(message: SipMessage, to: TransportAddress): TransactionOutput {
  return { type: "send", message, to }
}

export function notify(event: TransactionEvent): TransactionOutput {
  return { type: "event", event }
}
