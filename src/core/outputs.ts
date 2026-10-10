import { encodeMessage } from "../message/serialize"
import type { SipMessage } from "../message/types"
import type { TransportAddress } from "../transport/address"
import type { CoreEvent, CoreOutput } from "./types"

export function send(message: SipMessage, to: TransportAddress): CoreOutput {
  return { type: "send", data: encodeMessage(message), to }
}

export function event(coreEvent: CoreEvent): CoreOutput {
  return { type: "event", event: coreEvent }
}
