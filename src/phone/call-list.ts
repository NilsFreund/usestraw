import { createCallId } from "../core/ids"
import type { CallEvent, CoreCommand } from "../core/types"
import { isRequestUri, splitSipUri } from "../message/fields/uri"
import { show } from "../message/syntax"
import { isIntegerIn } from "../support/integer"
import { isIpv4 } from "../support/ip"
import { MAX_DELAY } from "../support/time"
import type { TransportAddress } from "../transport/address"
import { type CallHandle, type CallSetup, checkAgent, createCall, mediaOf } from "./call"
import { createInbox } from "./inbox"
import type { AudioOptions, CallAudio } from "./platform"
import { secureRandom } from "./random"
import type {
  Call,
  CallOptions,
  CloseOptions,
  LiveCall,
  RingingCall,
  UnansweredCall,
} from "./types"

export interface CallListSetup {
  readonly aor: string
  readonly domain: string
  readonly server: () => TransportAddress
  readonly openAudio: (silent: () => void, options: AudioOptions) => Promise<CallAudio>
  readonly run: (command: CoreCommand) => void
  readonly changed: () => void
}

/** The phone's calls in both directions, and the queue of those that ring. */
export interface CallList {
  readonly incoming: AsyncIterable<RingingCall>
  /** The calls that have not ended, a new array only when something changed. */
  readonly calls: readonly Call[]
  /** True once new callers are turned away. */
  readonly draining: boolean
  receive(event: CallEvent): void
  /** Checks what `phone.call()` got and returns the SIP URI to call. */
  check(to: string, options: CallOptions): string
  place(uri: string, options: CallOptions): Promise<LiveCall | UnansweredCall>
  turnAway(): void
  endAll(options: CloseOptions, timeout: number): Promise<void>
  dropAll(timeout: number): Promise<void>
  close(): void
}

const DIALLED = /^\+?[\d\s().\-/]+$/
// +49 (0)30 …: the national trunk prefix in brackets is not dialled from abroad
const TRUNK_PREFIX = /^(\+\d{1,3})\s*\(0\)/

export function createCallList(setup: CallListSetup): CallList {
  const { aor, domain, server, openAudio, run, changed } = setup
  const handles = new Map<string, CallHandle>()
  const inbox = createInbox()
  let calls: readonly Call[] = []
  let draining = false

  function refresh(): void {
    calls = Object.freeze(
      [...handles.values()].map((handle) => handle.call).filter((call) => call.status !== "ended"),
    )
    changed()
  }

  function track(call: Omit<CallSetup, "openAudio" | "run" | "changed">): CallHandle {
    const { id } = call
    const handle = createCall({ ...call, openAudio, run, changed: refresh })
    handles.set(id, handle)
    void handle.call.ended.then(() => handles.delete(id))
    refresh()
    return handle
  }

  function receive(event: CallEvent): void {
    if (event.state !== "incoming") {
      handles.get(event.call)?.receive(event)
      return
    }
    const { call: id, from, to } = event
    if (draining) {
      run({ type: "end", call: id })
      return
    }
    const named = from.name === undefined ? {} : { callerName: from.name }
    const parties = { from: userOf(from.uri), to: userOf(to.uri), ...named }
    inbox.push(track({ id, direction: "incoming", ...parties, offer: event.description }))
  }

  // Checked before the phone's state, as fetch checks its arguments first
  function check(to: string, options: CallOptions): string {
    const { agent, timeout } = options
    if (agent) checkAgent(agent)
    if (timeout !== undefined && !isIntegerIn(timeout, 1, MAX_DELAY)) {
      throw new RangeError(
        `The timeout must be a whole number of milliseconds from 1 to ${MAX_DELAY}, got ${show(timeout)}`,
      )
    }
    const uri = targetUri(to, domain)
    const parts = isRequestUri(uri) ? splitSipUri(uri) : undefined
    if (!parts?.hostport.replace(/:\d*$/, "") || parts.user === "") throw cannotCall(to)
    return uri
  }

  async function place(uri: string, options: CallOptions): Promise<LiveCall | UnansweredCall> {
    const { agent, signal, timeout } = options
    const id = createCallId(secureRandom)
    const parties = { from: userOf(aor), to: userOf(uri), ...(agent ? { agent } : {}) }
    const handle = track({ id, direction: "outgoing", ...parties })
    const gaveUp = () => handle.giveUp("cancelled")
    signal?.addEventListener("abort", gaveUp, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await dial(handle, uri)
      // The ring time starts once the call went out, not while a browser asks for the microphone
      if (timeout !== undefined) timer = setTimeout(() => handle.giveUp("no-answer"), timeout)
      const result = await handle.answered
      if (!result.ok && signal?.aborted) throw signal.reason
      return result
    } finally {
      signal?.removeEventListener("abort", gaveUp)
      clearTimeout(timer)
    }
  }

  // A call that ended while the microphone or its offer was on the way just settles as it ended
  async function dial(handle: CallHandle, uri: string): Promise<void> {
    try {
      const audio = await handle.open()
      if (draining) void handle.call.end()
      const media = await mediaOf(audio)
      handle.place({ type: "call", call: handle.call.id, uri, to: server(), media })
    } catch (error) {
      if (handle.call.status === "ended") return
      void handle.call.end()
      throw error
    }
  }

  function running(): Call[] {
    return [...handles.values()].map((handle) => handle.call)
  }

  function turnAway(): void {
    draining = true
  }

  // Ringing calls are turned down; answered ones, and those being answered, may finish with drain
  async function endAll(options: CloseOptions, timeout: number): Promise<void> {
    turnAway()
    inbox.close()
    const ending = running()
    for (const call of ending) {
      if (!options.drain || call.status === "ringing") void call.end()
    }
    const ended = Promise.all(ending.map((call) => call.ended))
    if (options.drain) {
      await until(ended, options.signal)
      for (const call of ending) void call.end()
    }
    if (ending.length > 0) await until(ended, AbortSignal.timeout(timeout))
  }

  async function dropAll(timeout: number): Promise<void> {
    const ending = running()
    for (const handle of handles.values()) handle.drop("dropped")
    await until(Promise.all(ending.map((call) => call.ended)), AbortSignal.timeout(timeout))
  }

  function close(): void {
    turnAway()
    inbox.close()
    const ended = { by: "local", reason: "dropped" } as const
    for (const [call, handle] of handles)
      handle.receive({ type: "call", call, state: "ended", ended })
    handles.clear()
  }

  return {
    incoming: { [Symbol.asyncIterator]: () => inbox[Symbol.asyncIterator]() },
    get calls() {
      return calls
    },
    get draining() {
      return draining
    },
    receive,
    check,
    place,
    turnAway,
    endAll,
    dropAll,
    close,
  }
}

// RFC 3966: numbers as people write them, and tel: links, become SIP URIs at the phone's domain
export function targetUri(input: string, domain: string): string {
  const text = input.trim()
  const tel = /^tel:/i.test(text)
  const number = dialled(tel ? telNumber(input) : text)
  if (number) return `sip:${number}@${domain}`
  if (tel || text.startsWith("+") || isIpv4(text)) throw cannotCall(input)
  if (/^sips?:/i.test(text)) return text
  if (text.includes("@")) return `sip:${text}`
  return `sip:${text}@${domain}`
}

export function userOf(uri: string): string {
  return splitSipUri(uri)?.user ?? uri.replace(/^[a-z]+:/i, "")
}

function dialled(text: string): string | undefined {
  if (!DIALLED.test(text) || !/\d/.test(text) || isIpv4(text)) return undefined
  const digits = text.replace(TRUNK_PREFIX, "$1").replace(/\D/g, "")
  return text.startsWith("+") ? `+${digits}` : digits
}

// RFC 3966 §5.1: the number before its parameters; an extension has no SIP equivalent
function telNumber(input: string): string {
  const [number = "", ...params] = decode(input.trim().slice(4)).split(";")
  if (params.some((param) => /^ext=/i.test(param.trim()))) {
    throw new TypeError(`Cannot call ${show(input)}: extensions in tel: links are not supported`)
  }
  return number.trim()
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

function cannotCall(to: string): TypeError {
  return new TypeError(`Cannot call ${show(to)}: use a number, a user name or sip:user@host`)
}

async function until(promise: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    await promise
    return
  }
  const stopped = Promise.withResolvers<void>()
  const stop = () => stopped.resolve()
  signal.addEventListener("abort", stop, { once: true })
  if (signal.aborted) stop()
  await Promise.race([promise, stopped.promise])
  signal.removeEventListener("abort", stop)
}
