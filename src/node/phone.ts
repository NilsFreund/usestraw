import { createCore } from "../core/core"
import { createCallId } from "../core/ids"
import type { CoreEvent, CoreInput, CoreOutput } from "../core/types"
import { isRequestUri } from "../message/fields/uri"
import { show } from "../message/syntax"
import { createRecordedCore } from "../recorder/recorder"
import { isIntegerIn } from "../support/integer"
import {
  type Agent,
  type Call,
  type CallHandle,
  type CallSetup,
  checkAgent,
  createCall,
  type LiveCall,
  type RingingCall,
  targetUri,
  type UnansweredCall,
  userOf,
} from "./calls"
import { createClock } from "./clock"
import { debugOutput } from "./debug"
import { type ConnectError, connectError } from "./errors"
import { createIncoming } from "./incoming"
import { type Link, openLink } from "./links"
import { createListeners } from "./listeners"
import {
  type ConnectOptions,
  type ConnectUrlOptions,
  type PhoneSettings,
  resolveOptions,
} from "./options"
import { createPings, type Ping } from "./pings"
import { secureRandom } from "./random"

/**
 * `"connecting"` until the first registration, `"online"` while registered, `"reconnecting"` while
 * retrying after a failure, `"offline"` once closed or failed for good.
 */
export type PhoneStatus = "connecting" | "online" | "reconnecting" | "offline"

const MAX_TIMEOUT = 2 ** 31 - 1

/** Options for {@link Phone.call}. */
export interface CallOptions {
  /** Talks for you once the call is answered. */
  readonly agent?: Agent | undefined
  /** How long to ring, in ms, before giving up with `reason: "no-answer"`. */
  readonly timeout?: number | undefined
  /** Cancels the call like `fetch` does. No effect once the call is answered. */
  readonly signal?: AbortSignal | undefined
}

/** Options for {@link Phone.close}. */
export interface CloseOptions {
  /** Lets running calls finish and turns new ones away as busy. Without it, calls are hung up. */
  readonly drain?: boolean | undefined
  /** Stops the drain and hangs up whatever is still running. */
  readonly signal?: AbortSignal | undefined
}

/** A registered phone. Read its fields; `subscribe` tells you when they change. */
export interface Phone extends AsyncDisposable {
  readonly status: PhoneStatus
  /** Why the phone is reconnecting or offline. */
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
   * Calls a number, user name or SIP address. Numbers like `"+49 30 123 45-67"` work. Like `fetch`,
   * it resolves for busy and unanswered calls too, so check `ok`.
   *
   * @example
   * ```ts
   * const call = await phone.call("+49 30 1234567", { timeout: 30_000 })
   * if (!call.ok) console.log(call.reason)
   * ```
   * @throws {TypeError} for an address it cannot call, or an agent already in use
   * @throws {RangeError} for a timeout that is not a positive integer
   * @throws {DOMException} `InvalidStateError` once the phone is closing
   * @throws the signal's reason when it aborts first, or a socket error when no audio port is free
   */
  call(to: string, options?: CallOptions): Promise<LiveCall | UnansweredCall>
  /**
   * Calls `listener` when `status`, `error`, `retryAt` or `calls` change, and returns an
   * unsubscribe function. Works with React's `useSyncExternalStore`.
   */
  subscribe(listener: () => void): () => void
  /** Hangs up, unregisters and goes offline. Calling it again returns the same promise. */
  close(options?: CloseOptions): Promise<void>
}

export interface PhoneHandle extends Phone {
  ping(uri?: string): Promise<Ping>
}

/**
 * Registers a phone with your SIP server and resolves once it's online. After that it re-registers
 * and reconnects on its own. The URL looks like `tls://user:password@host[:port]` or `udp://…`,
 * with special characters in the password percent-encoded.
 *
 * @example
 * ```ts
 * const phone = await connect("tls://alice:secret@sip.example.com")
 * const phone = await connect(process.env.SIP_URL, { maxCalls: 20 })
 * ```
 * @throws {ConnectError} when the server cannot be reached or refuses the registration
 * @throws {TypeError} for a malformed URL, or when `url` is `undefined`
 */
export function connect(url: string | undefined, options?: ConnectUrlOptions): Promise<Phone>
/**
 * Same, with options instead of a URL. Useful when the server isn't at your SIP domain.
 *
 * @example
 * ```ts
 * const phone = await connect({
 *   uri: "sip:+4930123456@sip.example.com",
 *   password: process.env.SIP_PASSWORD,
 *   server: "tls://edge.example.com",
 * })
 * ```
 */
export function connect(options: ConnectOptions): Promise<Phone>
export async function connect(
  target: string | ConnectOptions | undefined,
  options?: ConnectUrlOptions,
): Promise<Phone> {
  return connectPhone(resolveOptions(target, options))
}

export async function connectPhone(settings: PhoneSettings): Promise<PhoneHandle> {
  const { server, tls, signal, connectTimeout, label, username } = settings
  signal?.throwIfAborted()
  const timeout = AbortSignal.timeout(connectTimeout)
  const connecting = signal ? AbortSignal.any([signal, timeout]) : timeout
  const link = await openLink(server, tls, connecting).catch((error: Error) => {
    signal?.throwIfAborted()
    const cause = timeout.aborted ? (timeout.reason as Error) : error
    throw connectError({ reason: "network" }, { label, username }, cause)
  })
  return startPhone(link, settings)
}

export async function startPhone(link: Link, settings: PhoneSettings): Promise<PhoneHandle> {
  const { aor, registrar, credentials, expires, closeTimeout, signal, label, username, trace } =
    settings
  const { maxCalls } = settings
  if (signal?.aborted) {
    link.close()
    throw signal.reason
  }
  const context = { label, username }
  const coreOptions = {
    address: link.local,
    aor,
    random: secureRandom,
    ...(credentials ? { credentials } : {}),
    ...(maxCalls === undefined ? {} : { maxCalls }),
  }
  const debug = debugOutput()
  const recorder = trace || debug ? createRecordedCore(coreOptions, { onStep: debug }) : undefined
  const core = recorder ?? createCore(coreOptions)
  const clock = createClock()
  const listeners = createListeners()
  const pings = createPings()
  const handles = new Map<string, CallHandle>()
  const incoming = createIncoming()
  const domain = registrar.slice(registrar.indexOf(":") + 1)
  const starting = Promise.withResolvers<void>()
  let status: PhoneStatus = "connecting"
  let error: ConnectError | undefined
  let retryAt: number | undefined
  let started = false
  let leaving: (() => void) | undefined
  let closing: Promise<void> | undefined
  let draining = false
  let snapshot: readonly Call[] = []

  function deliver(outputs: CoreOutput[]): void {
    for (const output of outputs) {
      if (output.type === "send") link.send(output.data, output.to)
      else notice(output.event)
    }
    clock.schedule(core.nextDeadline(), () => run({ type: "timeout" }))
  }

  function run(input: CoreInput): void {
    if (status !== "offline") deliver(core.handle(input, clock.now()))
  }

  function notice(event: CoreEvent): void {
    pings.settle(event, clock.now())
    if (event.type === "call") dispatch(event)
    if (event.type !== "registration") return
    if (leaving || event.state === "unregistered") leaving?.()
    else if (event.state === "registered") update("online")
    else {
      const failure = connectError(event.failure, context)
      if (event.retryIn === undefined) stop(failure)
      else update("reconnecting", failure, Date.now() + event.retryIn)
    }
  }

  function refresh(): void {
    snapshot = [...handles.values()]
      .map((handle) => handle.call)
      .filter((call) => call.status !== "ended")
    listeners.notify()
  }

  function dispatch(event: Extract<CoreEvent, { type: "call" }>): void {
    if (event.state !== "incoming") {
      handles.get(event.call)?.receive(event)
      return
    }
    const { call: id, from, to } = event
    if (draining) {
      run({ type: "command", command: { type: "end", call: id } })
      return
    }
    const named = from.name === undefined ? {} : { callerName: from.name }
    incoming.push(
      track({ id, direction: "incoming", from: userOf(from.uri), to: userOf(to.uri), ...named }),
    )
  }

  function track(setup: Omit<CallSetup, "host" | "run" | "changed">): CallHandle {
    const { id } = setup
    const handle = createCall({
      ...setup,
      host: link.local.host,
      run: (command) => run({ type: "command", command }),
      changed: refresh,
    })
    handles.set(id, handle)
    void handle.call.ended.then(() => {
      handles.delete(id)
      refresh()
    })
    refresh()
    return handle
  }

  function closed(): boolean {
    return draining || status === "offline"
  }

  async function call(
    target: string,
    options: CallOptions = {},
  ): Promise<LiveCall | UnansweredCall> {
    const { agent, signal: abort, timeout } = options
    abort?.throwIfAborted()
    if (closed()) throw new DOMException("The phone is closed", "InvalidStateError")
    if (agent) checkAgent(agent)
    if (timeout !== undefined && !isIntegerIn(timeout, 1, MAX_TIMEOUT)) {
      throw new RangeError(`The timeout must be a number of milliseconds, got ${show(timeout)}`)
    }
    const uri = targetUri(target, domain)
    if (!isRequestUri(uri)) {
      throw new TypeError(`Cannot call ${show(target)}: use a number, a user name or sip:user@host`)
    }
    const id = createCallId(secureRandom)
    const parties = { from: userOf(aor), to: userOf(uri), ...(agent ? { agent } : {}) }
    const handle = track({ id, direction: "outgoing", ...parties })
    const gaveUp = () => handle.giveUp("cancelled")
    abort?.addEventListener("abort", gaveUp, { once: true })
    const timer =
      timeout === undefined ? undefined : setTimeout(() => handle.giveUp("no-answer"), timeout)
    try {
      const audio = await handle.open().catch((error: unknown) => {
        void handle.call.end()
        throw error
      })
      if (closed()) void handle.call.end()
      handle.place({ type: "call", call: id, uri, to: link.remote, media: audio.local })
      const result = await handle.answered
      if (!result.ok && abort?.aborted) throw abort.reason
      return result
    } finally {
      abort?.removeEventListener("abort", gaveUp)
      clearTimeout(timer)
    }
  }

  function update(next: "online" | "reconnecting", failure?: ConnectError, at?: number): void {
    const changed = next !== status || failure !== error || at !== retryAt
    status = next
    error = failure
    retryAt = at
    if (changed) listeners.notify()
    if (next === "online") starting.resolve()
    else starting.reject(failure)
  }

  function lost(cause?: Error): void {
    stop(leaving ? undefined : connectError({ reason: "network" }, context, cause))
  }

  function stop(failure?: ConnectError): void {
    if (status === "offline") return
    status = "offline"
    error = failure
    retryAt = undefined
    clock.cancel()
    link.close()
    signal?.removeEventListener("abort", abort)
    pings.abort(new DOMException("The phone is closed", "InvalidStateError"))
    for (const [call, handle] of handles) {
      handle.receive({
        type: "call",
        call,
        state: "ended",
        ended: { by: "local", reason: "timeout" },
      })
    }
    handles.clear()
    incoming.close()
    listeners.notify()
    leaving?.()
    starting.reject(failure)
  }

  function abort(): void {
    if (started) {
      void close()
      return
    }
    starting.reject(signal?.reason)
    stop()
  }

  async function leave(options: CloseOptions): Promise<void> {
    draining = true
    incoming.close()
    const calls = [...handles.values()].map((handle) => handle.call)
    for (const call of calls) if (!options.drain || call.status === "ringing") void call.end()
    const ended = Promise.all(calls.map((call) => call.ended))
    if (options.drain) {
      await until(ended, options.signal)
      for (const call of calls) void call.end()
    }
    if (calls.length > 0) await until(ended, AbortSignal.timeout(closeTimeout))
    const { promise, resolve } = Promise.withResolvers<void>()
    leaving = resolve
    const timer = setTimeout(resolve, closeTimeout)
    try {
      if (status !== "offline") {
        run({ type: "command", command: { type: "unregister" } })
        await promise
      }
    } finally {
      clearTimeout(timer)
      stop()
    }
  }

  function close(options: CloseOptions = {}): Promise<void> {
    closing ??= leave(options)
    return closing
  }

  async function ping(uri = registrar): Promise<Ping> {
    if (draining || status === "offline") {
      throw new DOMException("The phone is closed", "InvalidStateError")
    }
    const callId = createCallId(secureRandom)
    const started = clock.now()
    run({ type: "command", command: { type: "options", uri, to: link.remote, callId } })
    return pings.wait(callId, started)
  }

  signal?.addEventListener("abort", abort, { once: true })
  try {
    link.start({ receive: (data, from) => run({ type: "receive", data, from }), close: lost })
    const registration = {
      to: link.remote,
      registrar,
      ...(expires === undefined ? {} : { expires }),
    }
    run({ type: "command", command: { type: "register", ...registration } })
    await starting.promise
  } catch (thrown) {
    stop()
    throw thrown
  }
  started = true
  return {
    get status() {
      return status
    },
    get error() {
      return error
    },
    get retryAt() {
      return retryAt
    },
    get trace() {
      return trace ? recorder?.recording() : undefined
    },
    get calls() {
      return snapshot
    },
    incoming,
    call,
    subscribe: listeners.subscribe,
    ping,
    close,
    [Symbol.asyncDispose]: close,
  }
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
