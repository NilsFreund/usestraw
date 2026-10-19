import type { ConnectError, ConnectReason } from "./connect-error"
import type { PhoneStatus } from "./status"

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

/**
 * Incoming calls start as `"ringing"` and are `"answering"` from `accept()` until the caller
 * confirms; outgoing ones start as `"calling"`. Both go `"live"` when answered and end as
 * `"ended"`. This list is complete: things like hold or mute will be fields, not statuses.
 */
export type CallStatus = "ringing" | "answering" | "calling" | "live" | "ended"

/** How a call ended. */
export interface CallEnded {
  /** `"us"` if this phone hung up, cancelled or declined, otherwise `"them"`. */
  readonly by: "us" | "them"
  /** Why it ended, e.g. `"hangup"`, `"busy"` or `"no-answer"`. */
  readonly reason: CallReason
}

/** A live call's audio: 16-bit mono PCM at `sampleRate`, both ways. An agent locks both streams. */
export interface CallAudioStreams {
  /**
   * What the other side says: a 20 ms frame (160 samples at 8 kHz) every 20 ms, silence included.
   * Closes when the call ends. A reader that falls behind loses the oldest frames.
   */
  readonly readable: ReadableStream<Int16Array<ArrayBuffer>>
  /**
   * What the other side hears, in chunks of any size. Writes resolve at once until 30 s are queued.
   * `close()` resolves when the last sample is out, without hanging up. Once the call ends, writes
   * and a pending `close()` reject with an `AbortError`.
   */
  readonly writable: WritableStream<Int16Array>
  /** Samples per second, 8000 for now. Check it before you resample. */
  readonly sampleRate: number
  /** Milliseconds of written audio sent so far, not counting silence. */
  readonly played: number
  /** Drops written audio that hasn't played yet. Use it for barge-in. */
  clear(): void
}

/**
 * Turns what the caller says into what they hear, usually a `TransformStream`. It gets 20 ms frames
 * of 8 kHz PCM and may write chunks of any size. When it closes its output or fails, the call hangs
 * up; when the call is never answered, its writable is aborted. Use a new agent for every call.
 *
 * @example
 * ```ts
 * const echo = () => new TransformStream<Int16Array, Int16Array>()
 * for await (const call of phone.incoming) void call.accept(echo())
 * ```
 */
export type Agent = ReadableWritablePair<Int16Array, Int16Array<ArrayBuffer>>

/** Options for `call.end()`. */
export interface EndOptions {
  /**
   * For a ringing call: `"busy"` (default) lets your other devices keep ringing, `"declined"` stops
   * them all. Ignored once live.
   */
  readonly reason?: "busy" | "declined" | undefined
}

/** A call as plain data, as `JSON.stringify` and `console.log` show it. Frozen. */
export interface CallSnapshot {
  readonly id: string
  readonly direction: "incoming" | "outgoing"
  readonly from: string
  readonly to: string
  readonly callerName?: string
  readonly status: CallStatus
  readonly ok: boolean
  readonly reason?: CallReason
}

/** Shared by every call state. */
export interface CallBase extends AsyncDisposable {
  /** Unique and stable for the call's life, so it works as a React key. Treat it as opaque. */
  readonly id: string
  readonly direction: "incoming" | "outgoing"
  /** The caller's number or user name, e.g. `"+442079460456"`, or `"anonymous"`. */
  readonly from: string
  /** The number or user name that was called. */
  readonly to: string
  /** The display name the caller sent. Don't trust it. */
  readonly callerName: string | undefined
  readonly status: CallStatus
  /** `true` once answered, and it stays `true` after the hang-up. */
  readonly ok: boolean
  /** Why the call ended, once it has. */
  readonly reason: CallReason | undefined
  /** Resolves when the call ends. Never rejects. */
  readonly ended: Promise<CallEnded>
  /** Calls `listener` when `status`, `ok` or `reason` change, and returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Declines a ringing call, cancels a calling one, or hangs up. Never rejects. */
  end(options?: EndOptions): Promise<CallEnded>
  /**
   * The call as plain data: the same frozen object until the call changes, so it works as a
   * `useSyncExternalStore` snapshot.
   */
  toJSON(): CallSnapshot
}

/**
 * An incoming call that is ringing, or ended meanwhile: the caller can give up at any time. Once you
 * accept it, go on with the call that `accept()` returns.
 */
export interface RingingCall extends CallBase {
  readonly status: "ringing" | "ended"
  /**
   * Answers the call. Talk through the agent, or through `audio` on the returned call. Resolves to
   * an {@link UnansweredCall} if the caller gave up first, even while the microphone was being
   * asked for, or no audio port was free. Rejects for an agent that is already in use. In the
   * browser it also rejects when the microphone is denied, missing or busy (`NotAllowedError`,
   * `NotFoundError`, `NotReadableError`), and the call keeps `"ringing"`, so you can try again.
   *
   * @example
   * ```ts
   * for await (const call of phone.incoming) {
   *   void call.accept(new TransformStream()) // an echo
   * }
   * ```
   */
  accept(agent?: Agent): Promise<LiveCall | UnansweredCall>
}

/** An incoming call that was accepted and waits for the caller to confirm, or ended meanwhile. */
export interface AnsweringCall extends CallBase {
  readonly status: "answering" | "ended"
}

/** An outgoing call that has not been answered yet, or ended meanwhile. */
export interface CallingCall extends CallBase {
  readonly status: "calling" | "ended"
}

/** An answered call. Its `status` becomes `"ended"` after the hang-up. */
export interface LiveCall extends CallBase {
  readonly status: "live" | "ended"
  readonly ok: true
  /** The call's audio. */
  readonly audio: CallAudioStreams
}

/** A call that has ended. */
export interface EndedCall extends CallBase {
  readonly status: "ended"
  readonly reason: CallReason
}

/** A call that ended without an answer. */
export interface UnansweredCall extends EndedCall {
  readonly ok: false
}

/** A call in any state. Narrow it with `status` or `ok`; `await using` hangs it up. */
export type Call = RingingCall | AnsweringCall | CallingCall | LiveCall | EndedCall

/** Options for `phone.call()`. */
export interface CallOptions {
  /** Talks for you once the call is answered. */
  readonly agent?: Agent | undefined
  /** How long to ring, in ms, before giving up with `reason: "no-answer"`. */
  readonly timeout?: number | undefined
  /** Cancels the call like `fetch` does. No effect once the call is answered. */
  readonly signal?: AbortSignal | undefined
}

/** Options for `phone.close()`. */
export interface CloseOptions {
  /**
   * Lets answered calls, and those being answered, finish, and turns new ones away as busy.
   * Without it, calls are hung up.
   */
  readonly drain?: boolean | undefined
  /** Stops the drain and hangs up whatever is still running. */
  readonly signal?: AbortSignal | undefined
}

/** A phone as plain data, as `JSON.stringify` and `console.log` show it, without the trace. Frozen. */
export interface PhoneSnapshot {
  readonly status: PhoneStatus
  readonly error?: { readonly reason: ConnectReason; readonly message: string }
  readonly retryAt?: number
  readonly calls: readonly CallSnapshot[]
}

/** A connected phone. Read its fields; `subscribe` tells you when they change. */
export interface Phone extends AsyncDisposable {
  readonly status: PhoneStatus
  /** Why the phone is reconnecting, or why it closed on its own. */
  readonly error: ConnectError | undefined
  /** When the next reconnect attempt happens, as a `Date.now()` timestamp. */
  readonly retryAt: number | undefined
  /**
   * The latest 512 KB of SIP traffic, timers and random draws, with password hashes masked. Draw
   * it with `ladder()` or rerun it with `replay()` from `usestraw/core`.
   */
  readonly trace: string | undefined
  /** Calls that haven't ended, in both directions. A new array only when something changed. */
  readonly calls: readonly Call[]
  /**
   * Ringing calls, for `for await`. Ends when the phone closes. Don't `await` a whole call inside
   * the loop, or the next caller waits.
   *
   * @example
   * ```ts
   * for await (const call of phone.incoming) {
   *   if (call.from === "anonymous") void call.end({ reason: "declined" })
   *   else void call.accept(createAgent())
   * }
   * ```
   */
  readonly incoming: AsyncIterable<RingingCall>
  /**
   * Calls a number, user name or SIP address. Numbers like `"+44 20 7946-0123"` and `tel:` links
   * work. Like `fetch`, it resolves for busy and unanswered calls too, so check `ok`.
   *
   * @example
   * ```ts
   * const call = await phone.call("+44 20 7946 0123", { timeout: 30_000 })
   * if (!call.ok) console.log(call.reason)
   * ```
   * @throws {TypeError} for an address it cannot call, or an agent already in use
   * @throws {RangeError} for a timeout that is not a positive integer
   * @throws {DOMException} `InvalidStateError` once the phone is closing, or in the browser when
   *   the microphone is denied, missing or busy
   * @throws {ConnectError} while the connection to the server is lost
   * @throws the signal's reason when it aborts first, or a socket error when no audio port is free
   */
  call(to: string, options?: CallOptions): Promise<LiveCall | UnansweredCall>
  /**
   * Calls `listener` when `status`, `error`, `retryAt` or `calls` change, and returns an
   * unsubscribe function. Works with React's `useSyncExternalStore`.
   */
  subscribe(listener: () => void): () => void
  /** Hangs up, unregisters and closes. Calling it again returns the same promise. */
  close(options?: CloseOptions): Promise<void>
  /**
   * The phone as plain data, without the trace: the same frozen object until something changes, so
   * it works as a `useSyncExternalStore` snapshot.
   */
  toJSON(): PhoneSnapshot
}
