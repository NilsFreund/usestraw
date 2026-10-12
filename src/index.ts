/**
 * Make and take phone calls from Node, with each call's audio as Web Streams of 8 kHz PCM.
 *
 * @example
 * ```ts
 * import { connect } from "usestraw"
 *
 * const phone = await connect(process.env.SIP_URL)
 * for await (const call of phone.incoming) {
 *   void call.accept(new TransformStream()) // an echo: callers hear themselves
 * }
 * ```
 *
 * @module
 */
export { connect } from "./node/connect"
export type {
  Agent,
  AnsweringCall,
  Call,
  CallAudioStreams,
  CallEnded,
  CallingCall,
  CallReason,
  CallSnapshot,
  CallStatus,
  EndedCall,
  EndOptions,
  LiveCall,
  RingingCall,
  UnansweredCall,
} from "./phone/call"
export { ConnectError, type ConnectErrorOptions, type ConnectReason } from "./phone/connect-error"
export type { ConnectOptions, ConnectUrlOptions, TlsOptions } from "./phone/options"
export type {
  CallOptions,
  CloseOptions,
  Phone,
  PhoneSnapshot,
  PhoneStatus,
} from "./phone/phone"
