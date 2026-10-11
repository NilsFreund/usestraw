import { phraseFor } from "../message/phrases"
import { createResponse } from "../message/response"
import type { SipRequest, SipResponse } from "../message/types"

const TIME = /^\d+(?:\.\d*)?$/

// RFC 3261 §8.2.6.1: a 100 echoes the Timestamp and adds how long we held the request
export function createTrying(invite: SipRequest, waited: number): SipResponse {
  const timestamp = invite.headers.find((header) => header.name === "Timestamp")
  const [time = ""] = timestamp?.value.split(/[ \t]+/) ?? []
  if (!TIME.test(time)) return createResponse(invite, 100, phraseFor(100))
  const delay = Number((Math.max(0, waited) / 1000).toFixed(3))
  return createResponse(invite, 100, phraseFor(100), {
    headers: [{ name: "Timestamp", value: `${time} ${delay}` }],
  })
}
