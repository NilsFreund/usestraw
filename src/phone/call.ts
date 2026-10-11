import type { CallEnd, CallEvent, CoreCommand } from "../core/types"
import type { CallMedia } from "../sdp/types"
import { createListeners } from "./listeners"
import type { CallAudio } from "./platform"

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

/** A call as plain data, as `JSON.stringify` and `console.log` show it. */
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
interface CallBase extends AsyncDisposable {
  /** Unique and stable for the call's life, so it works as a React key. Treat it as opaque. */
  readonly id: string
  readonly direction: "incoming" | "outgoing"
  /** The caller's number or user name, e.g. `"+4930123456"`, or `"anonymous"`. */
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
  /** Calls `listener` on every change and returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Declines a ringing call, cancels a calling one, or hangs up. Never rejects. */
  end(options?: EndOptions): Promise<CallEnded>
  /** The call as plain data. */
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
   * an {@link UnansweredCall} if the caller gave up first or no audio port was free. Rejects only
   * for an agent that is already in use.
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

export interface CallSetup {
  readonly id: string
  readonly direction: "incoming" | "outgoing"
  readonly from: string
  readonly to: string
  readonly callerName?: string
  readonly agent?: Agent
  readonly openAudio: (silent: () => void) => Promise<CallAudio>
  readonly run: (command: CoreCommand) => void
  readonly changed: () => void
}

export interface CallHandle {
  readonly call: Call
  readonly answered: Promise<LiveCall | UnansweredCall>
  receive(event: CallEvent): void
  open(): Promise<CallAudio>
  place(command: CoreCommand): void
  giveUp(reason: CallReason): void
  drop(reason: CallReason): void
}

// Every state's fields in one object, so a call keeps its identity while its status changes
interface CallObject extends CallBase {
  readonly status: CallStatus
  readonly audio?: CallAudioStreams | undefined
  accept?(agent?: Agent): Promise<LiveCall | UnansweredCall>
}

const STATUSES: Readonly<Record<NonNullable<EndOptions["reason"]>, number>> = {
  busy: 486,
  declined: 603,
}

export function checkAgent(agent: Agent): void {
  if (agent.readable.locked || agent.writable.locked) {
    throw new TypeError(
      "This agent already talks on another call: create a new agent for each call",
    )
  }
}

export function createCall(setup: CallSetup): CallHandle {
  const { id, direction, from, to, callerName, openAudio, run, changed } = setup
  const listeners = createListeners()
  const settled = Promise.withResolvers<CallEnded>()
  const answer = Promise.withResolvers<LiveCall | UnansweredCall>()
  let status: CallStatus = direction === "incoming" ? "ringing" : "calling"
  let placed = direction === "incoming"
  let ok = false
  let reason: CallReason | undefined
  let override: CallReason | undefined
  let ending = false
  let audio: CallAudio | undefined
  let streams: CallAudioStreams | undefined
  let opening: Promise<CallAudio> | undefined
  let accepting: Promise<LiveCall | UnansweredCall> | undefined
  let agent = setup.agent

  function set(next: CallStatus): void {
    status = next
    listeners.notify()
    changed()
  }

  // A platform that throws instead of rejecting must not leave the call hanging
  function open(): Promise<CallAudio> {
    const opened = () =>
      new Promise<CallAudio>((resolve) => resolve(openAudio(() => drop("dropped"))))
    opening ??= opened().then((sound) => {
      audio = sound
      streams = view(sound)
      if (status === "ended") sound.close()
      return sound
    })
    return opening
  }

  function place(command: CoreCommand): void {
    if (status === "ended") return
    placed = true
    run(command)
  }

  function receive(event: CallEvent): void {
    if (event.state === "live") live(event.media)
    else if (event.state === "ended") finish(event.ended)
  }

  function live(media: CallMedia | undefined): void {
    if (media) audio?.update(media)
    if (status === "live" || status === "ended") return
    ok = true
    set("live")
    if (audio && agent) attach(audio, agent)
    answer.resolve(call as LiveCall)
  }

  function release(talker: Agent): void {
    const unanswered = new DOMException("The call ended before it was answered", "AbortError")
    talker.writable.abort(unanswered).catch(() => undefined)
    talker.readable.cancel(unanswered).catch(() => undefined)
  }

  function attach(sound: CallAudio, talker: Agent): void {
    const hangUp = () => end()
    try {
      void sound.readable.pipeThrough(talker).pipeTo(sound.writable).then(hangUp, hangUp)
    } catch {
      void hangUp()
    }
  }

  function finish(ended: CallEnd): void {
    if (status === "ended") return
    reason = override ?? ended.reason
    audio?.close()
    if (agent && !ok) release(agent)
    set("ended")
    const by = override !== undefined || ended.by === "local" ? "us" : "them"
    settled.resolve({ by, reason })
    answer.resolve(call as UnansweredCall)
  }

  // Never rejects for a free agent, so `call.accept(agent)` without await cannot crash the process
  function accept(next?: Agent): Promise<LiveCall | UnansweredCall> {
    if (accepting) return accepting
    if (next) {
      try {
        checkAgent(next)
      } catch (error) {
        return Promise.reject(error)
      }
    }
    if (status !== "ringing") {
      if (next) release(next)
      accepting = answer.promise
      return accepting
    }
    agent = next
    accepting = answering()
    set("answering")
    return accepting
  }

  async function answering(): Promise<LiveCall | UnansweredCall> {
    finishAnswer(await open().catch(() => undefined))
    return answer.promise
  }

  function finishAnswer(opened: CallAudio | undefined): void {
    if (status !== "answering") return
    if (opened) run({ type: "accept", call: id, media: opened.local })
    else run({ type: "end", call: id, status: 503 })
  }

  function end(options: EndOptions = {}): Promise<CallEnded> {
    if (status === "ended") return settled.promise
    if (!placed) {
      finish({ by: "local", reason: "cancelled" })
      return settled.promise
    }
    ending = true
    const rejection = options.reason === undefined ? {} : { status: STATUSES[options.reason] }
    run({ type: "end", call: id, ...rejection })
    return settled.promise
  }

  function drop(why: CallReason): void {
    if (ending) return
    override = why
    void end()
  }

  function giveUp(why: CallReason): void {
    if (status === "calling") drop(why)
  }

  function snapshot(): CallSnapshot {
    return {
      id,
      direction,
      from,
      to,
      ...(callerName === undefined ? {} : { callerName }),
      status,
      ok,
      ...(reason === undefined ? {} : { reason }),
    }
  }

  const call: CallObject = {
    id,
    direction,
    from,
    to,
    callerName,
    get status() {
      return status
    },
    get ok() {
      return ok
    },
    get reason() {
      return reason
    },
    get audio() {
      return streams
    },
    ended: settled.promise,
    subscribe: listeners.subscribe,
    accept,
    end,
    toJSON: snapshot,
    [Symbol.for("nodejs.util.inspect.custom")]: snapshot,
    [Symbol.asyncDispose]: async () => {
      await end()
    },
  }

  return { call: call as Call, answered: answer.promise, receive, open, place, giveUp, drop }
}

function view(audio: CallAudio): CallAudioStreams {
  return {
    readable: audio.readable,
    writable: audio.writable,
    sampleRate: audio.sampleRate,
    get played() {
      return audio.played
    },
    clear: () => audio.clear(),
  }
}
