import { type Core, createCore } from "../core/core"
import { createCallId } from "../core/ids"
import type { CoreEvent, CoreInput, CoreOutput } from "../core/types"
import { isRequestUri } from "../message/fields/uri"
import { show } from "../message/syntax"
import { createRecordedCore, type RecordedCore } from "../recorder/recorder"
import { isIntegerIn } from "../support/integer"
import type { TransportAddress } from "../transport/address"
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
 * retrying after a failure, `"offline"` once closed or failed for good. With `register: false`,
 * answers to a SIP ping every minute stand in for the registration.
 */
export type PhoneStatus = "connecting" | "online" | "reconnecting" | "offline"

const MAX_TIMEOUT = 2 ** 31 - 1
// Short registrations keep NAT bindings fresh and let a restarted phone take over its line sooner
const REGISTRATION = 600
const MAX_RECONNECT = 60_000
const STABLE = 60_000
const STALE = REGISTRATION * 1000
// Without a registration, an answered OPTIONS every minute shows the server is still there
const CHECK = 60_000

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

/** A connected phone. Read its fields; `subscribe` tells you when they change. */
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
   * @throws {ConnectError} while the phone reconnects
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
  const { server, tls, localPort: port, signal, connectTimeout, label, username } = settings
  signal?.throwIfAborted()
  const timeout = AbortSignal.timeout(connectTimeout)
  const connecting = signal ? AbortSignal.any([signal, timeout]) : timeout
  const link = await openLink(server, { tls, port }, connecting).catch((error: Error) => {
    signal?.throwIfAborted()
    const cause = timeout.aborted ? (timeout.reason as Error) : error
    throw connectError({ reason: "network" }, { label, username }, cause)
  })
  const reopen = (cancel: AbortSignal) => {
    const stops = [cancel, AbortSignal.timeout(connectTimeout), ...(signal ? [signal] : [])]
    return openLink(server, { tls, port }, AbortSignal.any(stops))
  }
  return startPhone(link, settings, reopen)
}

export async function startPhone(
  first: Link,
  settings: PhoneSettings,
  reopen?: (cancel: AbortSignal) => Promise<Link>,
): Promise<PhoneHandle> {
  const { aor, registrar, credentials, expires, closeTimeout, signal, label, username, trace } =
    settings
  const { maxCalls, acceptFrom } = settings
  if (signal?.aborted) {
    first.close()
    throw signal.reason
  }
  const context = { label, username }
  const debug = debugOutput()
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
  let link = first
  let connected = false
  let attempts = 0
  let onlineAt = 0
  let resumedAt: number | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  const cancel = new AbortController()
  // One core for the phone's whole life: a new connection keeps the registration, its binding
  // and the calls. Over TLS only the server reaches us anyway
  const coreOptions = {
    address: first.local,
    aor,
    random: secureRandom,
    ...(credentials ? { credentials } : {}),
    ...(maxCalls === undefined ? {} : { maxCalls }),
    ...(acceptFrom !== "anyone" && first.local.transport === "UDP"
      ? { acceptFrom: [...first.peers, ...(acceptFrom === "server" ? [] : acceptFrom)] }
      : {}),
  }
  let recorder: RecordedCore | undefined
  let core: Core
  try {
    recorder = trace || debug ? createRecordedCore(coreOptions, { onStep: debug }) : undefined
    core = recorder ?? createCore(coreOptions)
  } catch (thrown) {
    first.close()
    throw thrown
  }

  function open(next: Link): void {
    link = next
    connected = true
    next.start({ receive, close: lost })
    checkIn()
  }

  // Without a registration, any answer to OPTIONS shows the server is there
  function checkIn(): void {
    if (settings.register) {
      const registration = { to: link.remote, registrar, expires: expires ?? REGISTRATION }
      run({ type: "command", command: { type: "register", ...registration } })
      return
    }
    sendOptions(registrar).then(
      () => {
        update("online")
        retry = setTimeout(checkIn, CHECK)
      },
      (thrown: unknown) => {
        if (!(thrown instanceof DOMException && thrown.name === "TimeoutError")) return
        later(connectError({ reason: "timeout" }, context))
        if (link.local.transport === "TLS") link.close()
      },
    )
  }

  function deliver(outputs: CoreOutput[]): void {
    for (const output of outputs) {
      if (output.type === "send") {
        if (connected) link.send(output.data, output.to)
      } else notice(output.event)
    }
    if (status !== "offline") clock.schedule(core.nextDeadline(), () => run({ type: "timeout" }))
  }

  function run(input: CoreInput): void {
    if (status !== "offline") deliver(core.handle(input, clock.now()))
  }

  function receive(data: Uint8Array, from: TransportAddress): void {
    try {
      run({ type: "receive", data, from })
    } catch (thrown) {
      stop(connectError({ reason: "network" }, context, thrown as Error))
    }
  }

  function notice(event: CoreEvent): void {
    pings.settle(event, clock.now())
    if (event.type === "call") dispatch(event)
    if (event.type !== "registration") return
    if (leaving || event.state === "unregistered") leaving?.()
    else if (event.state === "registered") update("online")
    else {
      const failure = connectError(event.failure, context)
      if (event.retryIn !== undefined) update("reconnecting", failure, Date.now() + event.retryIn)
      else if (
        event.failure.reason === "rejected" &&
        resumedAt !== undefined &&
        performance.now() - resumedAt < STALE
      )
        later(failure)
      else fatal(failure)
      if (event.failure.reason === "timeout" && link.local.transport === "TLS") link.close()
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
    if (!connected) throw error
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
    if (next === "online" && status !== "online") onlineAt = performance.now()
    if (next === "online") resumedAt = undefined
    status = next
    error = failure
    retryAt = at
    if (changed) listeners.notify()
    if (next === "online") starting.resolve()
    else starting.reject(failure)
  }

  // A dropped connection keeps the registration and the calls, and the phone dials back in
  function lost(cause?: Error): void {
    if (status === "offline") return
    const failure = connectError({ reason: "network" }, context, cause)
    if (leaving || !started || !reopen) {
      stop(leaving ? undefined : failure)
      return
    }
    connected = false
    clearTimeout(retry)
    if (performance.now() - onlineAt > STABLE) attempts = 0
    reconnect(failure, reopen)
    pings.abort(new DOMException("The connection to the server was lost", "NetworkError"))
  }

  function backoff(): number {
    const ceiling = Math.min(MAX_RECONNECT, 1000 * 2 ** attempts)
    attempts += 1
    return Math.round(ceiling * (0.5 + secureRandom() / 2))
  }

  function reconnect(failure: ConnectError, again: (cancel: AbortSignal) => Promise<Link>): void {
    const delay = backoff()
    update("reconnecting", failure, Date.now() + delay)
    retry = setTimeout(() => {
      update("reconnecting", failure)
      again(cancel.signal)
        .then((next) => {
          if (status === "offline") {
            next.close()
            return
          }
          resumedAt = performance.now()
          open(next)
        })
        .catch((thrown: Error) => {
          if (status !== "offline") {
            reconnect(connectError({ reason: "network" }, context, thrown), again)
          }
        })
    }, delay)
  }

  // Right after a reconnect the registrar may still count our old binding and refuse a new one
  function later(failure: ConnectError): void {
    const delay = backoff()
    update("reconnecting", failure, Date.now() + delay)
    retry = setTimeout(() => {
      update("reconnecting", failure)
      checkIn()
    }, delay)
  }

  function end(ended: { readonly by: "local"; readonly reason: "timeout" }): void {
    for (const [call, handle] of handles) {
      handle.receive({ type: "call", call, state: "ended", ended })
    }
    handles.clear()
  }

  function fatal(failure: ConnectError): void {
    const running = [...handles.values()]
    if (running.length === 0) {
      stop(failure)
      return
    }
    draining = true
    error = failure
    listeners.notify()
    for (const handle of running) handle.drop("timeout")
    const ended = Promise.all(running.map((handle) => handle.call.ended))
    void until(ended, AbortSignal.timeout(closeTimeout)).then(() => stop(failure))
  }

  function stop(failure?: ConnectError): void {
    if (status === "offline") return
    status = "offline"
    error = failure
    retryAt = undefined
    clock.cancel()
    clearTimeout(retry)
    cancel.abort()
    link.close()
    signal?.removeEventListener("abort", abort)
    pings.abort(new DOMException("The phone is closed", "InvalidStateError"))
    end({ by: "local", reason: "timeout" })
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
      if (status !== "offline" && connected && settings.register) {
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
    if (!connected) throw error
    return sendOptions(uri)
  }

  function sendOptions(uri: string): Promise<Ping> {
    const callId = createCallId(secureRandom)
    const started = clock.now()
    run({ type: "command", command: { type: "options", uri, to: link.remote, callId } })
    return pings.wait(callId, started)
  }

  signal?.addEventListener("abort", abort, { once: true })
  const giveUp = setTimeout(
    () => stop(connectError({ reason: "timeout" }, context)),
    settings.connectTimeout,
  )
  try {
    open(first)
    await starting.promise
  } catch (thrown) {
    stop()
    throw thrown
  } finally {
    clearTimeout(giveUp)
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
