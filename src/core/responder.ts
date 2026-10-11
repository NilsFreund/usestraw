import { encodeMessage } from "../message/serialize"
import type { SipRequest } from "../message/types"
import { topVia } from "../transaction/keys"
import type { TransportAddress } from "../transport/address"
import { replyAddress } from "../transport/routing"
import { emit } from "./outputs"
import { createStateless } from "./stateless"
import type { CoreOutput, Random } from "./types"
import { type Answer, answer } from "./uas"

export interface Responder {
  respond(request: SipRequest, from: TransportAddress, reply?: Answer): CoreOutput[]
}

export function createResponder(random: Random): Responder {
  const stateless = createStateless(random)

  function respond(
    request: SipRequest,
    from: TransportAddress,
    reply = answer(request),
  ): CoreOutput[] {
    if (request.method === "ACK") {
      return stateless.acknowledges(request) ? [] : [emit({ type: "request", request, from })]
    }
    const answered = emit({ type: "answered", request, from, status: reply.status })
    const data = encodeMessage(stateless.reply(request, reply))
    return [answered, { type: "send", data, to: replyAddress(topVia(request), from) }]
  }

  return { respond }
}
