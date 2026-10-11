import { MAX_FORWARDS } from "../message/limits"
import type { SipRequest, SipResponse } from "../message/types"
import { topVia } from "./keys"

// RFC 3261 §17.1.1.3: the ACK for a final answer that is not 2xx belongs to the INVITE transaction
export function createFailureAck(invite: SipRequest, response: SipResponse): SipRequest {
  return {
    method: "ACK",
    uri: invite.uri,
    via: [topVia(invite)],
    maxForwards: MAX_FORWARDS,
    from: invite.from,
    to: response.to,
    callId: invite.callId,
    cseq: { seq: invite.cseq.seq, method: "ACK" },
    contact: [],
    headers: invite.headers.filter((header) => header.name === "Route"),
    body: new Uint8Array(),
  }
}
