import { serializeMessage } from "../message/serialize"
import type { SipMessage } from "../message/types"
import type { Address } from "../transport/address"
import type { CoreEvent, Output } from "./types"

export function send(message: SipMessage, to: Address): Output {
  return { type: "send", data: serializeMessage(message), to }
}

export function event(coreEvent: CoreEvent): Output {
  return { type: "event", event: coreEvent }
}
