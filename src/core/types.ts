import type { SipMessage, SipRequest } from "../message/types"
import type { TransactionEvent } from "../transaction/types"
import type { Address } from "../transport/address"

export type Random = () => number

export type Command =
  | { readonly type: "options"; readonly uri: string; readonly to: Address }
  | { readonly type: "send"; readonly message: SipMessage; readonly to: Address }

export type Input =
  | { readonly type: "receive"; readonly data: Uint8Array; readonly from: Address }
  | { readonly type: "timeout" }
  | { readonly type: "command"; readonly command: Command }

export type CoreEvent =
  | Exclude<TransactionEvent, { readonly type: "request" }>
  | { readonly type: "request"; readonly request: SipRequest; readonly from: Address }
  | { readonly type: "invalid"; readonly error: string; readonly from: Address }

export type Output =
  | { readonly type: "send"; readonly data: Uint8Array; readonly to: Address }
  | { readonly type: "event"; readonly event: CoreEvent }
