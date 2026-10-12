import { createCallId } from "../core/ids"
import type { CoreEvent, CoreInput, CoreOutput } from "../core/types"
import type { TransportAddress } from "../transport/address"
import { createCallList } from "./call-list"
import { createClock } from "./clock"
import type { ConnectError } from "./connect-error"
import { connectFirst, createConnection } from "./connection"
import { asyncDispose } from "./dispose"
import { toConnectError } from "./failures"
import { createListeners } from "./listeners"
import type { PhoneSettings } from "./options"
import { startCore } from "./phone-core"
import { createPings, type Ping } from "./pings"
import type { Link, Platform } from "./platform"
import { secureRandom } from "./random"
import { createRetry } from "./retry"
import { createStatus, snapshotOf } from "./status"
import type {
  CallOptions,
  CloseOptions,
  LiveCall,
  Phone,
  PhoneSnapshot,
  UnansweredCall,
} from "./types"

// Short registrations keep NAT bindings fresh and let a restarted phone take over its line sooner
const EXPIRES = 600
// A registrar may count an old binding until it expires, so a refusal that soon is waited out
const OLD_BINDING = EXPIRES * 1000
// Without a registration, an answered OPTIONS every minute shows the server is still there
const PING_INTERVAL = 60_000

export interface PhoneHandle {
  readonly phone: Phone
  ping(uri?: string): Promise<Ping>
}

export async function connectPhone(
  settings: PhoneSettings,
  platform: Platform,
): Promise<PhoneHandle> {
  return startPhone(await connectFirst(settings, platform), settings, platform)
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
  let started = false
  let leaving: (() => void) | undefined
  let shutdown: Promise<void> | undefined
  const connection = createConnection({
    first,
    platform,
    clock,
    connectTimeout,
    cancel: cancel.signal,
    receive,
    opened,
    lost,
    failed: (thrown) => reconnect(toConnectError({ reason: "network" }, context, thrown)),
  })
  const list = createCallList({
    aor,
    domain: registrar.slice(registrar.indexOf(":") + 1),
    server: () => connection.link.remote,
    openAudio: (silent) => platform.openAudio(connection.link.local.host, silent),
    run: (command) => run({ type: "command", command }),
    changed,
  })
  const { recorder, core } = startCore(first, settings, platform)

  function changed(): void {
    shown = undefined
    listeners.notify()
  }

  function snapshot(): PhoneSnapshot {
    shown ??= snapshotOf(state, list.calls)
    return shown
  }

  // Each connection has its own local port, which Via and Contact have to carry
  function opened(): void {
    run({ type: "command", command: { type: "move", address: connection.link.local } })
    checkIn()
  }

  function checkIn(): void {
    if (settings.register) {
      const registration = { to: connection.link.remote, registrar, expires: expires ?? EXPIRES }
      run({ type: "command", command: { type: "register", ...registration } })
      return
    }
    sendOptions(registrar).then(
      () => {
        update("online")
        retry.after(PING_INTERVAL, checkIn)
      },
      (thrown: unknown) => {
        if (!(thrown instanceof DOMException && thrown.name === "TimeoutError")) return
        later(toConnectError({ reason: "timeout" }, context))
        if (connection.link.local.transport === "TLS") connection.link.close()
      },
    )
  }

  function deliver(outputs: CoreOutput[]): void {
    for (const output of outputs) {
      if (output.type === "event") notice(output.event)
      else connection.send(output.data, output.to)
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
      stop(toConnectError({ reason: "network" }, context, thrown))
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
    const { resumedAt } = connection
    const justBack = resumedAt !== undefined && clock.now() - resumedAt < OLD_BINDING
    if (retryIn !== undefined) update("reconnecting", failure, Date.now() + retryIn)
    else if (failed.reason === "rejected" && justBack) later(failure)
    else fatal(failure)
    if (failed.reason === "timeout" && connection.link.local.transport === "TLS") {
      connection.link.close()
    }
  }

  function closing(): boolean {
    return list.draining || state.status === "closed"
  }

  async function call(to: string, options: CallOptions = {}): Promise<LiveCall | UnansweredCall> {
    const uri = list.check(to, options)
    options.signal?.throwIfAborted()
    if (closing()) throw new DOMException("The phone is closed", "InvalidStateError")
    if (!connection.connected) throw state.error
    return list.place(uri, options)
  }

  function update(next: "online" | "reconnecting", failure?: ConnectError, at?: number): void {
    if (next === "online" && state.status !== "online") retry.online()
    if (next === "online") connection.online()
    state.update(next, failure, at)
  }

  // A dropped connection keeps the registration and the calls, and the phone dials back in
  function lost(cause?: Error): void {
    if (state.status === "closed") return
    if (leaving) {
      stop()
      return
    }
    retry.cancel()
    retry.lost()
    reconnect(toConnectError({ reason: "network" }, context, cause))
    pings.abort(new DOMException("The connection to the server was lost", "NetworkError"))
  }

  function reconnect(failure: ConnectError): void {
    wait(failure, connection.dial)
  }

  // Checks in again after a backoff, for a refusal right after a reconnect or an unanswered ping
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
    connection.link.close()
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
    await list.endAll(options, closeTimeout)
    const { promise, resolve } = Promise.withResolvers<void>()
    leaving = resolve
    const timer = setTimeout(resolve, closeTimeout)
    try {
      if (state.status !== "closed" && connection.connected && settings.register) {
        run({ type: "command", command: { type: "unregister" } })
        await promise
      }
    } finally {
      clearTimeout(timer)
      stop()
    }
  }

  function close(options: CloseOptions = {}): Promise<void> {
    shutdown ??= leave(options)
    return shutdown
  }

  async function ping(uri = registrar): Promise<Ping> {
    if (closing()) throw new DOMException("The phone is closed", "InvalidStateError")
    if (!connection.connected) throw state.error
    return sendOptions(uri)
  }

  function sendOptions(uri: string): Promise<Ping> {
    const callId = createCallId(secureRandom)
    const sentAt = clock.now()
    run({ type: "command", command: { type: "options", uri, to: connection.link.remote, callId } })
    return pings.wait(callId, sentAt)
  }

  signal?.addEventListener("abort", abort, { once: true })
  const giveUp = setTimeout(
    () => stop(toConnectError({ reason: "timeout" }, context)),
    connectTimeout,
  )
  try {
    connection.start()
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
