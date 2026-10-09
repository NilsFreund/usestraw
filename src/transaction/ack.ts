import type { SipRequest, SipResponse } from "../message/types"
import { topVia } from "./keys"

export function createAck(invite: SipRequest, response: SipResponse): SipRequest {
  return {
    method: "ACK",
    uri: invite.uri,
    via: [topVia(invite)],
    maxForwards: 70,
    from: invite.from,
    to: response.to,
    callId: invite.callId,
    cseq: { seq: invite.cseq.seq, method: "ACK" },
    contact: [],
    headers: invite.headers.filter((header) => header.name === "Route"),
    body: new Uint8Array(),
  }
}
