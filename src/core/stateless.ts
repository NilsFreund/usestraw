import { createResponse } from "../message/response"
import type { SipRequest, SipResponse } from "../message/types"
import { hash } from "../support/hash"
import { serverKey, serverKeys } from "../transaction/keys"
import { createTag } from "./ids"
import type { Random } from "./types"
import type { Answer } from "./uas"

export interface Stateless {
  reply(request: SipRequest, answer: Answer): SipResponse
  acknowledges(ack: SipRequest): boolean
}

export function createStateless(random: Random): Stateless {
  const salt = createTag(random)
  const tag = (key: string) => hash(`${salt}|${key}`).toString(36)

  return {
    reply: (request, { status, reason, headers }) =>
      createResponse(request, status, reason, { toTag: tag(serverKey(request)), headers }),
    acknowledges: (ack) => serverKeys(ack).some((key) => tag(key) === ack.to.params.get("tag")),
  }
}
