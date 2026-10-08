import type { SipMessage, SipRequest, SipResponse } from "../message/types"

export type Random = () => number

export type Transport = "UDP" | "TCP" | "TLS" | "WS" | "WSS"

export interface Address {
  readonly transport: Transport
  readonly host: string
  readonly port: number
}

export type Command =
  | { readonly type: "options"; readonly uri: string; readonly to: Address }
  | { readonly type: "send"; readonly message: SipMessage; readonly to: Address }

export type Input =
  | { readonly type: "receive"; readonly data: Uint8Array; readonly from: Address }
  | { readonly type: "timeout" }
  | { readonly type: "command"; readonly command: Command }

export type CoreEvent =
  | { readonly type: "request"; readonly request: SipRequest; readonly from: Address }
  | { readonly type: "response"; readonly response: SipResponse; readonly from: Address }
  | { readonly type: "stray"; readonly response: SipResponse; readonly from: Address }
  | { readonly type: "timeout"; readonly request: SipRequest }
  | { readonly type: "invalid"; readonly error: string; readonly from: Address }

export type Output =
  | { readonly type: "send"; readonly data: Uint8Array; readonly to: Address }
  | { readonly type: "event"; readonly event: CoreEvent }
