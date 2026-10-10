import { MAX_MESSAGE_SIZE } from "../message/limits"
import { serializeMessage } from "../message/serialize"
import type { SipRequest } from "../message/types"
import { topVia } from "../transaction/keys"
import type { Address } from "../transport/address"
import { replyAddress } from "../transport/routing"
import { event } from "./outputs"
import { createStateless } from "./stateless"
import type { Output, Random } from "./types"
import { type Answer, answer } from "./uas"

export interface Responder {
  respond(request: SipRequest, from: Address, reply?: Answer): Output[]
}

export function createResponder(random: Random): Responder {
  const stateless = createStateless(random)

  function respond(request: SipRequest, from: Address, reply = answer(request)): Output[] {
    if (request.method === "ACK") {
      return stateless.acknowledges(request) ? [] : [event({ type: "request", request, from })]
    }
    const answered = event({ type: "answered", request, from, status: reply.status })
    const data = serializeMessage(stateless.reply(request, reply))
    if (data.length > MAX_MESSAGE_SIZE) return [answered]
    return [answered, { type: "send", data, to: replyAddress(topVia(request), from) }]
  }

  return { respond }
}
