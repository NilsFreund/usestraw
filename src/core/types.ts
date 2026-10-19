import type { SipMessage, SipRequest, SipResponse } from "../message/types"
import type { CallMedia } from "../sdp/types"
import type { Random } from "../support/random"
import type { TimerSettings } from "../transaction/timers"
import type { TransportAddress } from "../transport/address"

export type { Random }

/** The account to answer digest challenges (RFC 7616, RFC 8760) with. */
export interface Credentials {
  readonly username: string
  readonly password: string
  readonly realm?: string | undefined
}

/**
 * What the app wants: register, call, accept, end, ping or send a raw message. `move` follows a
 * new connection to its local address; register again, and that REGISTER asks to drop the old
 * Contact. `answer` answers a new offer from the far end with the app's own SDP, see
 * `CoreOptions.media`.
 */
export type CoreCommand =
  | {
      readonly type: "options"
      readonly uri: string
      readonly to: TransportAddress
      readonly callId?: string | undefined
    }
  | { readonly type: "send"; readonly message: SipMessage; readonly to: TransportAddress }
  | {
      readonly type: "register"
      readonly to: TransportAddress
      readonly registrar?: string | undefined
      readonly expires?: number | undefined
    }
  | { readonly type: "unregister" }
  | { readonly type: "move"; readonly address: TransportAddress }
  | {
      readonly type: "call"
      readonly call: string
      readonly uri: string
      readonly to: TransportAddress
      readonly media: LocalMedia | AppMedia
    }
  | { readonly type: "accept"; readonly call: string; readonly media: LocalMedia | AppMedia }
  | { readonly type: "answer"; readonly call: string; readonly media: AppMedia }
  | { readonly type: "end"; readonly call: string; readonly status?: number | undefined }

/** Where this phone receives RTP. `host` defaults to the core's own address. */
export interface LocalMedia {
  readonly host?: string | undefined
  readonly port: number
}

/**
 * The app's own SDP for a core with `media: "sdp"`, as an `RTCPeerConnection` makes it:
 * `pc.localDescription` fits as it is.
 */
export interface AppMedia {
  readonly sdp: string
}

/**
 * The far end's SDP for the app to apply, shaped like `RTCSessionDescriptionInit` so it goes
 * straight into `pc.setRemoteDescription()`. A `rollback` withdraws an offer the call no longer
 * waits on.
 */
export interface RemoteDescription {
  readonly type: "offer" | "pranswer" | "answer" | "rollback"
  readonly sdp?: string
}

/** A challenge the server offered: its scheme, realm and algorithm. */
export interface AuthChallenge {
  readonly scheme: string
  readonly realm?: string
  readonly algorithm?: string
}

/** Why a digest challenge went unanswered or the server refused the answer. */
export type AuthFailure =
  | { readonly reason: "no-credentials" }
  | { readonly reason: "unsupported-challenge"; readonly offered: readonly AuthChallenge[] }
  | { readonly reason: "unauthorized"; readonly status: number }

/** Why a registration failed: no answer, a refusal, a binding the server didn't keep, or auth. */
export type RegistrationFailure =
  | { readonly reason: "timeout" }
  | {
      readonly reason: "rejected"
      readonly status: number
      readonly phrase: string
      /** The refused REGISTER answered a challenge with the credentials. */
      readonly withCredentials?: true
    }
  | { readonly reason: "not-bound" }
  | AuthFailure

/** How the registration is doing; `retryIn` is in milliseconds. */
export type RegistrationEvent =
  | { readonly type: "registration"; readonly state: "registered"; readonly expires: number }
  | { readonly type: "registration"; readonly state: "unregistered" }
  | {
      readonly type: "registration"
      readonly state: "failed"
      readonly failure: RegistrationFailure
      readonly retryIn?: number
    }

/**
 * Why a call ended:
 *
 * - `"hangup"`: someone hung up a live call.
 * - `"cancelled"`: the caller gave up before the answer.
 * - `"answered-elsewhere"`: another of your devices took the call.
 * - `"busy"`: 486 or 600.
 * - `"declined"`: 603 or 607.
 * - `"not-found"`: no such number or user (404, 410, 484, 604).
 * - `"no-answer"`: nobody picked up in time (408, 480, or your `timeout`).
 * - `"unavailable"`: any 5xx.
 * - `"rejected"`: any other refusal (3xx, 4xx or 6xx).
 * - `"unauthorized"`: the server refused our credentials for this call.
 * - `"incompatible"`: no codec in common (488, 606).
 * - `"dropped"`: the other side stopped responding or sent no audio for a minute, or the phone closed.
 *
 * New reasons may come in minor versions, so keep a default branch when you switch on them.
 */
export type CallReason =
  | "hangup"
  | "cancelled"
  | "answered-elsewhere"
  | "busy"
  | "declined"
  | "not-found"
  | "no-answer"
  | "unavailable"
  | "rejected"
  | "unauthorized"
  | "incompatible"
  | "dropped"

/** Who ended a call, why, and the SIP status if there was one. */
export interface CallEnd {
  readonly by: "local" | "remote"
  readonly reason: CallReason
  readonly status?: number
}

/** A caller or callee as the From or To header names them. */
export interface CallParty {
  readonly uri: string
  readonly name?: string
}

/**
 * A call changed state; `call` is its id, the SIP Call-ID. With `media: "sdp"` the events carry
 * the far end's SDP in `description` whenever the app has something to apply, instead of the
 * agreed RTP `media`. An `offer` inside a call waits for an `answer` command; one without a
 * description asks the app for an offer of its own.
 */
export type CallEvent =
  | {
      readonly type: "call"
      readonly call: string
      readonly state: "incoming"
      readonly from: CallParty
      readonly to: CallParty
      readonly source: TransportAddress
      readonly description?: RemoteDescription
    }
  | {
      readonly type: "call"
      readonly call: string
      readonly state: "ringing"
      readonly status: number
      readonly media?: CallMedia
      readonly description?: RemoteDescription
    }
  | {
      readonly type: "call"
      readonly call: string
      readonly state: "live"
      readonly media?: CallMedia
      readonly description?: RemoteDescription
    }
  | {
      readonly type: "call"
      readonly call: string
      readonly state: "offer"
      readonly description?: RemoteDescription
    }
  | {
      readonly type: "call"
      readonly call: string
      readonly state: "ended"
      readonly ended: CallEnd
    }

/** A received datagram, a passed deadline, or an app command. */
export type CoreInput =
  | { readonly type: "receive"; readonly data: Uint8Array; readonly from: TransportAddress }
  | { readonly type: "timeout" }
  | { readonly type: "command"; readonly command: CoreCommand }

/**
 * What the core reports: registration and call changes, answers to pings, and invalid input.
 * A `request` is an ACK that matched nothing.
 */
export type CoreEvent =
  | { readonly type: "response"; readonly response: SipResponse; readonly from: TransportAddress }
  | { readonly type: "stray"; readonly response: SipResponse; readonly from: TransportAddress }
  | { readonly type: "timeout"; readonly request: SipRequest }
  | {
      readonly type: "unacknowledged"
      readonly request: SipRequest
      readonly response: SipResponse
    }
  | { readonly type: "request"; readonly request: SipRequest; readonly from: TransportAddress }
  | {
      readonly type: "answered"
      readonly request: SipRequest
      readonly from: TransportAddress
      readonly status: number
    }
  | { readonly type: "invalid"; readonly error: string; readonly from: TransportAddress }
  | RegistrationEvent
  | CallEvent

/** Bytes to send, or an event for the app. */
export type CoreOutput =
  | { readonly type: "send"; readonly data: Uint8Array; readonly to: TransportAddress }
  | { readonly type: "event"; readonly event: CoreEvent }

/**
 * Options for `createCore()`.
 *
 * @experimental `usestraw/core` may change in minor versions while the browser softphone takes shape.
 */
export interface CoreOptions {
  /** Where this phone receives SIP, as the far end sees it. */
  readonly address: TransportAddress
  /** The address of record, e.g. `"sip:alice@example.com"`. */
  readonly aor: string
  /** Source of tags, branches and nonces. Must be cryptographically secure. */
  readonly random: Random
  readonly credentials?: Credentials | undefined
  /**
   * RFC 3261 timers, for tests and unusual networks. Unset ones use `defaultTimers`, with T2
   * and Timer D raised to fit T1.
   */
  readonly timers?: Partial<Record<keyof TimerSettings, number | undefined>> | undefined
  /** Turns incoming calls away as busy (486) while this many calls run. Defaults to 100. */
  readonly maxCalls?: number | undefined
  /**
   * IP addresses and CIDR ranges that may start calls and other requests, such as the server's;
   * anyone when unset. Requests inside a call only need to match the call.
   */
  readonly acceptFrom?: readonly string[] | undefined
  /**
   * Who makes the SDP: Straw, as G.711 for the RTP address in each call's `media` (`"rtp"`), or
   * the app, as WebRTC does (`"sdp"`). Then `call`, `accept` and `answer` take `{ sdp }`, and the
   * far end's SDP reaches the app unread, in each event's `description`:
   *
   * - `incoming` carries the offer; without one, `accept` makes the offer and `live` brings the
   *   answer.
   * - `ringing` may carry a `pranswer`, and `live` the `answer` to an offer the app made.
   * - `offer` asks for an `answer` within 10 s, or the far end gets 488 and the app a `rollback`.
   *
   * End a call with status 488 when the app cannot use the far end's offer.
   *
   * @default "rtp"
   */
  readonly media?: "rtp" | "sdp" | undefined
  /**
   * The RFC 5626 instance id to register with over WebSocket, as `urn:uuid:…`. Keep it across
   * restarts, so a new registration replaces the old one; a random one when unset.
   */
  readonly instance?: string | undefined
}

/**
 * SIP as a pure state machine, with no sockets or clocks. Pass every input with the current time,
 * do what it returns, and send a `timeout` input once `nextDeadline()` has passed.
 *
 * @experimental `usestraw/core` may change in minor versions while the browser softphone takes shape.
 */
export interface Core {
  /**
   * Runs one input at time `now` (milliseconds, any monotonic clock) and returns what to do.
   *
   * @throws {TypeError | RangeError} for an invalid command or time, never for network input
   */
  handle(input: CoreInput, now: number): CoreOutput[]
  /** When the core next wants a `timeout` input, on the clock of `now`; `undefined` if never. */
  nextDeadline(): number | undefined
}
