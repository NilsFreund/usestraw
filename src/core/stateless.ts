import { createResponse } from "../message/response"
import type { SipRequest, SipResponse } from "../message/types"
import { toHex } from "../support/hex"
import { hmacSha256 } from "../support/hmac"
import { serverKey, serverKeys } from "../transaction/keys"
import type { Random } from "./types"
import type { Answer } from "./uas"

export interface Stateless {
  reply(request: SipRequest, answer: Answer): SipResponse
  acknowledges(ack: SipRequest): boolean
}

const encoder = new TextEncoder()
const SIGNED = 512

// To tags are a MAC of the transaction key, so a late ACK finds its answer without any state;
// only a prefix is signed, so a huge branch cannot make a tag expensive
export function createStateless(random: Random): Stateless {
  const secret = Uint8Array.from({ length: 32 }, () => Math.floor(random() * 256))
  const tag = (key: string) =>
    toHex(hmacSha256(secret, encoder.encode(key).subarray(0, SIGNED)).subarray(0, 8))

  return {
    reply: (request, { status, reason, headers }) =>
      createResponse(request, status, reason, { toTag: tag(serverKey(request)), headers }),
    acknowledges: (ack) => serverKeys(ack).some((key) => tag(key) === ack.to.params.get("tag")),
  }
}
