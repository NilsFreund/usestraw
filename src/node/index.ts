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
export type {
  Agent,
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
} from "./calls"
export { ConnectError, type ConnectErrorOptions, type ConnectReason } from "./errors"
export type { ConnectOptions, ConnectUrlOptions, TlsOptions } from "./options"
export { type CallOptions, type CloseOptions, connect, type Phone, type PhoneStatus } from "./phone"
