import { createCore } from "../core/core"
import { createCallId } from "../core/ids"
import type { CoreEvent, Input, Output } from "../core/types"
import { createBroadcast } from "./broadcast"
import { createClock } from "./clock"
import { RegistrationError } from "./errors"
import { type Link, openLink } from "./links"
import { type PhoneSettings, type RegisterOptions, resolveOptions } from "./options"
import { createPings, type Ping } from "./pings"
import { secureRandom } from "./random"

export type PhoneState = "registered" | "retrying" | "closed"

export type StateChange =
  | { readonly state: "registered"; readonly expires: number }
  | { readonly state: "retrying"; readonly error: RegistrationError; readonly retryIn: number }
  | { readonly state: "closed"; readonly error?: RegistrationError }

export interface Phone extends AsyncDisposable {
  readonly state: PhoneState
  readonly changes: AsyncIterable<StateChange>
  ping(uri?: string): Promise<Ping>
  close(): Promise<void>
}

export async function register(options: RegisterOptions): Promise<Phone> {
  return connectPhone(resolveOptions(options))
}

export async function connectPhone(settings: PhoneSettings): Promise<Phone> {
  const { server, tls, signal, connectTimeout } = settings
  signal?.throwIfAborted()
  const timeout = AbortSignal.timeout(connectTimeout)
  const connecting = signal ? AbortSignal.any([signal, timeout]) : timeout
  const link = await openLink(server, tls, connecting).catch((error: Error) => {
    signal?.throwIfAborted()
    const cause = timeout.aborted ? (timeout.reason as Error) : error
    throw new RegistrationError({ reason: "network" }, settings, cause)
  })
  return startPhone(link, settings)
}

export async function startPhone(link: Link, settings: PhoneSettings): Promise<Phone> {
  const { aor, registrar, credentials, expires, closeTimeout, signal } = settings
  if (signal?.aborted) {
    link.close()
    throw signal.reason
  }
  const core = createCore({
    address: link.local,
    aor,
    random: secureRandom,
    ...(credentials ? { credentials } : {}),
  })
  const clock = createClock()
  const changes = createBroadcast<StateChange>()
  const pings = createPings()
  const starting = Promise.withResolvers<void>()
  let state: PhoneState = "retrying"
  let leaving: (() => void) | undefined
  let closing: Promise<void> | undefined

  function deliver(outputs: Output[]): void {
    for (const output of outputs) {
      if (output.type === "send") link.send(output.data, output.to)
      else notice(output.event)
    }
    clock.schedule(core.nextDeadline(), () => run({ type: "timeout" }))
  }

  function run(input: Input): void {
    if (state !== "closed") deliver(core.handle(input, clock.now()))
  }

  function notice(event: CoreEvent): void {
    pings.settle(event, clock.now())
    if (event.type !== "registration") return
    if (leaving || event.state === "unregistered") leaving?.()
    else if (event.state === "registered") update({ state: "registered", expires: event.expires })
    else {
      const error = new RegistrationError(event.failure, settings)
      if (event.retryIn === undefined) stop(error)
      else update({ state: "retrying", error, retryIn: event.retryIn })
    }
  }

  function update(change: Exclude<StateChange, { readonly state: "closed" }>): void {
    if (change.state !== "registered" || state !== "registered") changes.publish(change)
    state = change.state
    if (change.state === "registered") starting.resolve()
    else starting.reject(change.error)
  }

  function lost(cause?: Error): void {
    stop(leaving ? undefined : new RegistrationError({ reason: "network" }, settings, cause))
  }

  function stop(error?: RegistrationError): void {
    if (state === "closed") return
    state = "closed"
    clock.cancel()
    link.close()
    pings.abort(new DOMException("The phone is closed", "InvalidStateError"))
    changes.publish(error ? { state: "closed", error } : { state: "closed" })
    changes.end()
    leaving?.()
    starting.reject(error)
  }

  async function leave(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    leaving = resolve
    const timer = setTimeout(resolve, closeTimeout)
    try {
      if (state !== "closed") {
        run({ type: "command", command: { type: "unregister" } })
        await promise
      }
    } finally {
      clearTimeout(timer)
      stop()
    }
  }

  function close(): Promise<void> {
    closing ??= leave()
    return closing
  }

  async function ping(uri = registrar): Promise<Ping> {
    if (leaving || state === "closed") {
      throw new DOMException("The phone is closed", "InvalidStateError")
    }
    const callId = createCallId(secureRandom)
    const started = clock.now()
    run({ type: "command", command: { type: "options", uri, to: link.remote, callId } })
    return pings.wait(callId, started)
  }

  const abort = () => {
    starting.reject(signal?.reason)
    stop()
  }
  signal?.addEventListener("abort", abort, { once: true })
  link.start({ receive: (data, from) => run({ type: "receive", data, from }), close: lost })
  const registration = {
    to: link.remote,
    registrar,
    ...(expires === undefined ? {} : { expires }),
  }
  run({ type: "command", command: { type: "register", ...registration } })
  try {
    await starting.promise
  } catch (error) {
    stop()
    throw error
  } finally {
    signal?.removeEventListener("abort", abort)
  }
  return {
    get state() {
      return state
    },
    changes: { [Symbol.asyncIterator]: () => changes[Symbol.asyncIterator]() },
    ping,
    close,
    [Symbol.asyncDispose]: close,
  }
}
