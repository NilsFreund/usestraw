import type { Contact } from "./fields/contact"
import type { CSeq } from "./fields/cseq"
import type { NameAddr } from "./fields/name-addr"
import type { Via } from "./fields/via"

/** A header as it appeared, for anything not parsed into its own field. */
export interface SipHeader {
  readonly name: string
  readonly value: string
}

/** What requests and responses share: the parsed core headers, the rest, and the body. */
export interface MessageFields {
  readonly via: readonly Via[]
  readonly from: NameAddr
  readonly to: NameAddr
  readonly callId: string
  readonly cseq: CSeq
  readonly maxForwards?: number | undefined
  readonly contact: Contact
  readonly headers: readonly SipHeader[]
  readonly body: Uint8Array
}

/** A SIP request, e.g. an INVITE. */
export interface SipRequest extends MessageFields {
  readonly method: string
  readonly uri: string
}

/** A SIP response, e.g. 200 OK. */
export interface SipResponse extends MessageFields {
  readonly status: number
  readonly reason: string
}

/** A request or a response; tell them apart with `isRequest`. */
export type SipMessage = SipRequest | SipResponse

/** `true` for requests, `false` for responses. */
export function isRequest(message: SipMessage): message is SipRequest {
  return "method" in message
}
