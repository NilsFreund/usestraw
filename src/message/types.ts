import type { Contact } from "./fields/contact"
import type { CSeq } from "./fields/cseq"
import type { NameAddr } from "./fields/name-addr"
import type { Via } from "./fields/via"

export interface Header {
  readonly name: string
  readonly value: string
}

export interface MessageFields {
  readonly via: readonly Via[]
  readonly from: NameAddr
  readonly to: NameAddr
  readonly callId: string
  readonly cseq: CSeq
  readonly maxForwards?: number
  readonly contact: Contact
  readonly headers: readonly Header[]
  readonly body: Uint8Array
}

export interface SipRequest extends MessageFields {
  readonly method: string
  readonly uri: string
}

export interface SipResponse extends MessageFields {
  readonly status: number
  readonly reason: string
}

export type SipMessage = SipRequest | SipResponse

export function isRequest(message: SipMessage): message is SipRequest {
  return "method" in message
}
