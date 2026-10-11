import { createResponse } from "../message/response"
import type { SipRequest, SipResponse } from "../message/types"
import { toHex } from "../support/hex"
import { hmacSha256 } from "../support/hmac"
import { type Random, randomInt } from "../support/random"
import { serverKey, serverKeys } from "../transaction/keys"
import type { Answer } from "./uas"

export interface Stateless {
  reply(request: SipRequest, answer: Answer): SipResponse
  acknowledges(ack: SipRequest): boolean
}

const encoder = new TextEncoder()
const SIGNED = 512

// To tags are a MAC of the transaction key's first 512 bytes, so a late ACK needs no state
export function createStateless(random: Random): Stateless {
  const secret = Uint8Array.from({ length: 32 }, () => randomInt(random, 256))
  const tag = (key: string) =>
    toHex(hmacSha256(secret, encoder.encode(key).subarray(0, SIGNED)).subarray(0, 8))

  return {
    reply: (request, { status, reason, headers }) =>
      createResponse(request, status, reason, { toTag: tag(serverKey(request)), headers }),
    acknowledges: (ack) => serverKeys(ack).some((key) => tag(key) === ack.to.params.get("tag")),
  }
}
