import { type Core, createCore } from "../core/core"
import { createCallId } from "../core/ids"
import type { CoreEvent, CoreInput, CoreOutput } from "../core/types"
import { createRecordedCore, type RecordedCore } from "../recorder/recorder"
import type { TransportAddress } from "../transport/address"
import type { Agent, Call, CallSnapshot, LiveCall, RingingCall, UnansweredCall } from "./call"
import { createCallList } from "./call-list"
import { createClock } from "./clock"
import type { ConnectError, ConnectReason } from "./connect-error"
import { asyncDispose } from "./dispose"
import { toConnectError } from "./failures"
import { createListeners } from "./listeners"
import type { PhoneSettings } from "./options"
import { createPings, type Ping } from "./pings"
import type { Link, Platform } from "./platform"
import { secureRandom } from "./random"
import { createRetry } from "./retry"
import { createStatus, type PhoneStatus } from "./status"

export type { PhoneStatus }

// Short registrations keep NAT bindings fresh and let a restarted phone take over its line sooner
const REGISTRATION = 600
const STALE = REGISTRATION * 1000
// Without a registration, an answered OPTIONS every minute shows the server is still there
const CHECK = 60_000

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
   * Calls a number, user name or SIP address. Numbers like `"+49 30 123 45-67"` and `tel:` links
   * work. Like `fetch`, it resolves for busy and unanswered calls too, so check `ok`.
   *
   * @example
   * ```ts
   * const call = await phone.call("+49 30 1234567", { timeout: 30_000 })
   * if (!call.ok) console.log(call.reason)
   * ```
   * @throws {TypeError} for an address it cannot call, or an agent already in use
   * @throws {RangeError} for a timeout that is not a positive integer
   * @throws {DOMException} `InvalidStateError` once the phone is closing, or `NotAllowedError`
   *   where a microphone is needed and denied
   * @throws {ConnectError} while the phone reconnects
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

export interface PhoneHandle {
  readonly phone: Phone
  ping(uri?: string): Promise<Ping>
}

export async function connectPhone(
  settings: PhoneSettings,
  platform: Platform,
): Promise<PhoneHandle> {
  const { signal, connectTimeout, label, username } = settings
  signal?.throwIfAborted()
  const timeout = AbortSignal.timeout(connectTimeout)
  const connecting = signal ? AbortSignal.any([signal, timeout]) : timeout
  const link = await platform.connect(connecting).catch((error: Error) => {
    signal?.throwIfAborted()
    const cause = timeout.aborted ? (timeout.reason as Error) : error
    throw toConnectError({ reason: "network" }, { label, username }, cause)
  })
  return startPhone(link, settings, platform)
}

export async function startPhone(
  first: Link,
  settings: PhoneSettings,
  platform: Platform,
): Promise<PhoneHandle> {
  const { aor, registrar, expires, closeTimeout, connectTimeout, signal, trace } = settings
  if (signal?.aborted) {
    first.close()
    throw signal.reason
  }
  const context = {
    label: settings.label,
    username: settings.username,
    realm: settings.credentials?.realm,
  }
  const clock = createClock()
  const listeners = createListeners()
  let shown: PhoneSnapshot | undefined
  const state = createStatus(changed)
  const retry = createRetry()
  const pings = createPings()
  const cancel = new AbortController()
  let link = first
  let connected = false
  let started = false
  let resumedAt: number | undefined
  let leaving: (() => void) | undefined
  let closing: Promise<void> | undefined
  const list = createCallList({
    aor,
    domain: registrar.slice(registrar.indexOf(":") + 1),
    server: () => link.remote,
    openAudio: (silent) => platform.openAudio(link.local.host, silent),
    run: (command) => run({ type: "command", command }),
    changed,
  })
  const { recorder, core } = startCore(first, settings, platform)

  function changed(): void {
    shown = undefined
    listeners.notify()
  }

  function snapshot(): PhoneSnapshot {
    shown ??= describe()
    return shown
  }

  function describe(): PhoneSnapshot {
    const { status, error, retryAt } = state
    return Object.freeze({
      status,
      ...(error ? { error: Object.freeze({ reason: error.reason, message: error.message }) } : {}),
      ...(retryAt === undefined ? {} : { retryAt }),
      calls: Object.freeze(list.calls.map((call) => call.toJSON())),
    })
  }

  // Each connection has its own local port, which Via and Contact have to carry
  function use(next: Link): void {
    link = next
    connected = true
    run({ type: "command", command: { type: "move", address: next.local } })
    next.start({ receive, close: lost })
    checkIn()
  }

  function checkIn(): void {
    if (settings.register) {
      const registration = { to: link.remote, registrar, expires: expires ?? REGISTRATION }
      run({ type: "command", command: { type: "register", ...registration } })
      return
    }
    sendOptions(registrar).then(
      () => {
        update("online")
        retry.after(CHECK, checkIn)
      },
      (thrown: unknown) => {
        if (!(thrown instanceof DOMException && thrown.name === "TimeoutError")) return
        later(toConnectError({ reason: "timeout" }, context))
        if (link.local.transport === "TLS") link.close()
      },
    )
  }

  function deliver(outputs: CoreOutput[]): void {
    for (const output of outputs) {
      if (output.type === "event") notice(output.event)
      else if (connected) link.send(output.data, output.to)
    }
    if (state.status !== "closed") {
      clock.schedule(core.nextDeadline(), () => run({ type: "timeout" }))
    }
  }

  function run(input: CoreInput): void {
    if (state.status !== "closed") deliver(core.handle(input, clock.now()))
  }

  function receive(data: Uint8Array, from: TransportAddress): void {
    try {
      run({ type: "receive", data, from })
    } catch (thrown) {
      stop(toConnectError({ reason: "network" }, context, thrown as Error))
    }
  }

  function notice(event: CoreEvent): void {
    pings.settle(event, clock.now())
    if (event.type === "call") list.receive(event)
    if (event.type !== "registration") return
    if (leaving || event.state === "unregistered") leaving?.()
    else if (event.state === "registered") update("online")
    else refused(event.failure, event.retryIn)
  }

  function refused(
    failed: Extract<CoreEvent, { type: "registration"; state: "failed" }>["failure"],
    retryIn?: number,
  ): void {
    const failure = toConnectError(failed, context)
    const stale = resumedAt !== undefined && performance.now() - resumedAt < STALE
    if (retryIn !== undefined) update("reconnecting", failure, Date.now() + retryIn)
    else if (failed.reason === "rejected" && stale) later(failure)
    else fatal(failure)
    if (failed.reason === "timeout" && link.local.transport === "TLS") link.close()
  }

  function closed(): boolean {
    return list.draining || state.status === "closed"
  }

  async function call(to: string, options: CallOptions = {}): Promise<LiveCall | UnansweredCall> {
    const uri = list.check(to, options)
    options.signal?.throwIfAborted()
    if (closed()) throw new DOMException("The phone is closed", "InvalidStateError")
    if (!connected) throw state.error
    return list.place(uri, options)
  }

  function update(next: "online" | "reconnecting", failure?: ConnectError, at?: number): void {
    if (next === "online" && state.status !== "online") retry.online()
    if (next === "online") resumedAt = undefined
    state.update(next, failure, at)
  }

  // A dropped connection keeps the registration and the calls, and the phone dials back in
  function lost(cause?: Error): void {
    if (state.status === "closed") return
    if (leaving) {
      stop()
      return
    }
    connected = false
    retry.cancel()
    retry.lost()
    reconnect(toConnectError({ reason: "network" }, context, cause))
    pings.abort(new DOMException("The connection to the server was lost", "NetworkError"))
  }

  function reconnect(failure: ConnectError): void {
    wait(failure, dial)
  }

  // Right after a reconnect the registrar may still count our old binding and refuse a new one
  function later(failure: ConnectError): void {
    wait(failure, checkIn)
  }

  function wait(failure: ConnectError, attempt: () => void): void {
    const delay = retry.later(() => {
      update("reconnecting", failure)
      attempt()
    })
    update("reconnecting", failure, Date.now() + delay)
  }

  function dial(): void {
    const stops = [cancel.signal, AbortSignal.timeout(connectTimeout), ...(signal ? [signal] : [])]
    platform.connect(AbortSignal.any(stops)).then(
      (next) => {
        if (state.status === "closed") {
          next.close()
          return
        }
        resumedAt = performance.now()
        use(next)
      },
      (thrown: Error) => {
        if (state.status !== "closed")
          reconnect(toConnectError({ reason: "network" }, context, thrown))
      },
    )
  }

  // Calls get a moment to end before the phone closes for good
  function fatal(failure: ConnectError): void {
    if (list.calls.length === 0) {
      stop(failure)
      return
    }
    list.turnAway()
    state.fail(failure)
    void list.dropAll(closeTimeout).then(() => stop(failure))
  }

  function stop(failure?: ConnectError, reason: unknown = failure): void {
    if (state.status === "closed") return
    state.close(failure, reason)
    clock.cancel()
    retry.cancel()
    cancel.abort()
    link.close()
    signal?.removeEventListener("abort", abort)
    pings.abort(new DOMException("The phone is closed", "InvalidStateError"))
    list.close()
    changed()
    leaving?.()
  }

  function abort(): void {
    if (started) void close()
    else stop(undefined, signal?.reason)
  }

  async function leave(options: CloseOptions): Promise<void> {
    await list.hangUp(options, closeTimeout)
    const { promise, resolve } = Promise.withResolvers<void>()
    leaving = resolve
    const timer = setTimeout(resolve, closeTimeout)
    try {
      if (state.status !== "closed" && connected && settings.register) {
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
    if (closed()) throw new DOMException("The phone is closed", "InvalidStateError")
    if (!connected) throw state.error
    return sendOptions(uri)
  }

  function sendOptions(uri: string): Promise<Ping> {
    const callId = createCallId(secureRandom)
    const sentAt = clock.now()
    run({ type: "command", command: { type: "options", uri, to: link.remote, callId } })
    return pings.wait(callId, sentAt)
  }

  signal?.addEventListener("abort", abort, { once: true })
  const giveUp = setTimeout(
    () => stop(toConnectError({ reason: "timeout" }, context)),
    connectTimeout,
  )
  try {
    use(first)
    await state.started
  } catch (thrown) {
    stop()
    throw thrown
  } finally {
    clearTimeout(giveUp)
  }
  started = true
  const phone: Phone = {
    get status() {
      return state.status
    },
    get error() {
      return state.error
    },
    get retryAt() {
      return state.retryAt
    },
    get trace() {
      return trace ? recorder?.recording() : undefined
    },
    get calls() {
      return list.calls
    },
    incoming: list.incoming,
    call,
    subscribe: listeners.subscribe,
    close,
    toJSON: snapshot,
    [Symbol.for("nodejs.util.inspect.custom")]: snapshot,
    [asyncDispose]: close,
  }
  return { phone, ping }
}

// One core for the phone's life, so a new connection keeps the registration and the calls
function startCore(
  first: Link,
  settings: PhoneSettings,
  platform: Platform,
): { readonly recorder: RecordedCore | undefined; readonly core: Core } {
  const { aor, credentials, maxCalls, acceptFrom, trace } = settings
  const { debug } = platform
  // Over TLS only the server reaches us anyway
  const filtered = acceptFrom !== "anyone" && first.local.transport === "UDP"
  const options = {
    address: first.local,
    aor,
    random: secureRandom,
    ...(credentials ? { credentials } : {}),
    ...(maxCalls === undefined ? {} : { maxCalls }),
    ...(filtered
      ? { acceptFrom: [...first.peers, ...(acceptFrom === "server" ? [] : acceptFrom)] }
      : {}),
  }
  try {
    const recorder = trace || debug ? createRecordedCore(options, { onStep: debug }) : undefined
    return { recorder, core: recorder ?? createCore(options) }
  } catch (thrown) {
    first.close()
    throw thrown
  }
}
