import type { CallEnd, CallEvent, CallReason, CoreCommand } from "../core/types"
import { splitSipUri } from "../message/fields/uri"
import type { CallMedia } from "../sdp/types"
import { type CallAudio, openAudio } from "./audio"
import { createListeners } from "./listeners"

export type { CallReason }

/**
 * Incoming calls start as `"ringing"`, outgoing ones as `"calling"`. Both go `"live"` when answered
 * and end as `"ended"`.
 */
export type CallStatus = "ringing" | "calling" | "live" | "ended"

/** How a call ended. */
export interface CallEnded {
  /** `"us"` if this phone hung up, cancelled or declined, otherwise `"them"`. */
  readonly by: "us" | "them"
  /** Why it ended, e.g. `"hangup"`, `"busy"` or `"no-answer"`. */
  readonly reason: CallReason
}

/** A live call's audio: 16-bit PCM at 8 kHz, both ways. An agent locks both streams. */
export interface CallAudioStreams {
  /**
   * What the other side says: 160 samples (20 ms) every 20 ms, silence included. Closes when the
   * call ends. A reader that falls behind loses the oldest frames.
   */
  readonly readable: ReadableStream<Int16Array<ArrayBuffer>>
  /**
   * What the other side hears, in chunks of any size. Writes resolve at once until 30 s are queued.
   * `close()` resolves when the last sample is out, without hanging up. After the call ends, writes
   * reject with an `AbortError`.
   */
  readonly writable: WritableStream<Int16Array>
  /** Always 8000. */
  readonly sampleRate: 8000
  /** Milliseconds of written audio sent so far, not counting silence. */
  readonly played: number
  /** Drops written audio that hasn't played yet. Use it for barge-in. */
  clear(): void
}

/**
 * Turns what the caller says into what they hear, usually a `TransformStream`. It gets 20 ms frames
 * of 8 kHz PCM and may write chunks of any size. When it closes its output or fails, the call hangs
 * up. Use a new agent for every call.
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
  /** The SIP Call-ID. Stable, so it works as a React key. */
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

/** An incoming call that is ringing. */
export interface RingingCall extends CallBase {
  readonly status: "ringing"
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

/** An outgoing call that has not been answered yet. */
export interface CallingCall extends CallBase {
  readonly status: "calling"
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
export type Call = RingingCall | CallingCall | LiveCall | EndedCall

export interface CallSetup {
  readonly id: string
  readonly direction: "incoming" | "outgoing"
  readonly from: string
  readonly to: string
  readonly callerName?: string
  readonly host: string
  readonly agent?: Agent
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
  const { id, direction, from, to, callerName, host, run, changed } = setup
  const listeners = createListeners()
  const settled = Promise.withResolvers<CallEnded>()
  const answer = Promise.withResolvers<LiveCall | UnansweredCall>()
  let status: CallStatus = direction === "incoming" ? "ringing" : "calling"
  let placed = direction === "incoming"
  let ok = false
  let reason: CallReason | undefined
  let override: CallReason | undefined
  let audio: CallAudio | undefined
  let opening: Promise<CallAudio> | undefined
  let accepting: Promise<LiveCall | UnansweredCall> | undefined
  let agent = setup.agent

  function set(next: CallStatus): void {
    status = next
    listeners.notify()
    changed()
  }

  function open(): Promise<CallAudio> {
    opening ??= openAudio(host).then((opened) => {
      audio = opened
      if (status === "ended") opened.close()
      return opened
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
    set("ended")
    const by = override !== undefined || ended.by === "local" ? "us" : "them"
    settled.resolve({ by, reason })
    answer.resolve(call as UnansweredCall)
  }

  function accept(next?: Agent): Promise<LiveCall | UnansweredCall> {
    if (next && accepting === undefined) {
      try {
        checkAgent(next)
      } catch (error) {
        return Promise.reject(error)
      }
    }
    accepting ??= answering(next)
    return accepting
  }

  // Never rejects, so `call.accept(agent)` without await cannot bring the process down
  async function answering(next?: Agent): Promise<LiveCall | UnansweredCall> {
    if (status !== "ringing") return answer.promise
    agent = next
    const opened = await open().catch(() => undefined)
    if (status !== "ringing") return answer.promise
    if (opened) run({ type: "accept", call: id, media: opened.local })
    else run({ type: "end", call: id, status: 503 })
    return answer.promise
  }

  function end(options: EndOptions = {}): Promise<CallEnded> {
    if (status === "ended") return settled.promise
    if (!placed) {
      finish({ by: "local", reason: "cancelled" })
      return settled.promise
    }
    const rejection = options.reason === undefined ? {} : { status: STATUSES[options.reason] }
    run({ type: "end", call: id, ...rejection })
    return settled.promise
  }

  function giveUp(why: CallReason): void {
    if (status !== "calling") return
    override = why
    void end()
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

  const call = {
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
      return audio
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
  } as unknown as Call

  return { call, answered: answer.promise, receive, open, place, giveUp }
}

// RFC 3966 style dialling: people write numbers with spaces, dashes and brackets
export function targetUri(input: string, domain: string): string {
  const text = input.trim()
  if (/^sips?:/i.test(text)) return text
  if (text.includes("@")) return `sip:${text}`
  if (/^\+?[\d\s().\-/]+$/.test(text) && /\d/.test(text)) {
    return `sip:${text.startsWith("+") ? "+" : ""}${text.replace(/\D/g, "")}@${domain}`
  }
  return `sip:${text}@${domain}`
}

export function userOf(uri: string): string {
  return splitSipUri(uri)?.user ?? uri.replace(/^[a-z]+:/i, "")
}
