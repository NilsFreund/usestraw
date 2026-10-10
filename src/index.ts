/**
 * The sans-I/O SIP core behind `usestraw`, for custom transports, tests and tools.
 *
 * @example
 * ```ts
 * import { createCore } from "usestraw/core"
 *
 * const core = createCore({ address, aor: "sip:alice@example.com", random })
 * const outputs = core.handle({ type: "receive", data, from }, performance.now())
 * ```
 *
 * @module
 */
export { type Core, type CoreOptions, createCore } from "./core/core"
export type {
  AuthChallenge,
  AuthFailure,
  CallEnd,
  CallEvent,
  CallParty,
  CallReason,
  CoreCommand,
  CoreEvent,
  CoreInput,
  CoreOutput,
  Credentials,
  LocalMedia,
  Random,
  RegistrationEvent,
  RegistrationFailure,
} from "./core/types"
export type { Contact } from "./message/fields/contact"
export type { CSeq } from "./message/fields/cseq"
export type { NameAddr } from "./message/fields/name-addr"
export type { Params } from "./message/fields/params"
export type { Via } from "./message/fields/via"
export { getHeader, getHeaders } from "./message/headers"
export { type ParseResult, parseMessage } from "./message/parse"
export { createResponse, type ResponseOptions } from "./message/response"
export { serializeMessage } from "./message/serialize"
export {
  isRequest,
  type MessageFields,
  type SipHeader,
  type SipMessage,
  type SipRequest,
  type SipResponse,
} from "./message/types"
export { ladder } from "./recorder/ladder"
export {
  createRecordedCore,
  type RecordedCore,
  type RecordedStep,
  type RecorderOptions,
} from "./recorder/recorder"
export { type ReplayResult, replay } from "./recorder/replay"
export type { CallMedia, Codec, MediaAddress, MediaDirection } from "./sdp/types"
export { defaultTimers, type TimerSettings } from "./transaction/timers"
export type { TransportAddress, TransportProtocol } from "./transport/address"
