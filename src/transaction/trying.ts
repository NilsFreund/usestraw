import { createResponse } from "../message/response"
import type { SipRequest, SipResponse } from "../message/types"

const TIME = /^\d+(?:\.\d*)?$/

export function createTrying(invite: SipRequest, waited: number): SipResponse {
  const timestamp = invite.headers.find((header) => header.name === "Timestamp")
  const [time = ""] = timestamp?.value.split(/[ \t]+/) ?? []
  if (!TIME.test(time)) return createResponse(invite, 100, "Trying")
  const delay = Number((Math.max(0, waited) / 1000).toFixed(3))
  return createResponse(invite, 100, "Trying", {
    headers: [{ name: "Timestamp", value: `${time} ${delay}` }],
  })
}
