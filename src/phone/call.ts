import type { CallEnd, CallEvent, CoreCommand } from "../core/types"
import type { CallMedia } from "../sdp/types"
import { asyncDispose } from "./dispose"
import { createListeners } from "./listeners"
import type { CallAudio } from "./platform"
import type {
  Agent,
  Call,
  CallAudioStreams,
  CallBase,
  CallEnded,
  CallReason,
  CallSnapshot,
  CallStatus,
  EndOptions,
  LiveCall,
  UnansweredCall,
} from "./types"

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
    throw new TypeError("This agent was already used for a call: create a new agent for each call")
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
  let shown: CallSnapshot | undefined
  let agent = setup.agent

  function set(next: CallStatus): void {
    status = next
    shown = undefined
    changed()
    listeners.notify()
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
    const over = () => end()
    try {
      void sound.readable.pipeThrough(talker).pipeTo(sound.writable).then(over, over)
    } catch {
      void over()
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
    shown ??= Object.freeze({
      id,
      direction,
      from,
      to,
      ...(callerName === undefined ? {} : { callerName }),
      status,
      ok,
      ...(reason === undefined ? {} : { reason }),
    })
    return shown
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
    [asyncDispose]: async () => {
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
