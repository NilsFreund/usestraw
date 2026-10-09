import { createCore } from "../core/core"
import { createCallId } from "../core/ids"
import type { CoreEvent, Input, Output } from "../core/types"
import { createClock } from "./clock"
import { type ConnectError, connectError } from "./errors"
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

export type PhoneStatus = "connecting" | "online" | "reconnecting" | "offline"

export interface Phone extends AsyncDisposable {
  readonly status: PhoneStatus
  readonly error: ConnectError | undefined
  readonly retryAt: number | undefined
  subscribe(listener: () => void): () => void
  close(): Promise<void>
}

export interface PhoneHandle extends Phone {
  ping(uri?: string): Promise<Ping>
}

export function connect(url: string | undefined, options?: ConnectUrlOptions): Promise<Phone>
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
  const { aor, registrar, credentials, expires, closeTimeout, signal, label, username } = settings
  if (signal?.aborted) {
    link.close()
    throw signal.reason
  }
  const context = { label, username }
  const core = createCore({
    address: link.local,
    aor,
    random: secureRandom,
    ...(credentials ? { credentials } : {}),
  })
  const clock = createClock()
  const listeners = createListeners()
  const pings = createPings()
  const starting = Promise.withResolvers<void>()
  let status: PhoneStatus = "connecting"
  let error: ConnectError | undefined
  let retryAt: number | undefined
  let started = false
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
    if (status !== "offline") deliver(core.handle(input, clock.now()))
  }

  function notice(event: CoreEvent): void {
    pings.settle(event, clock.now())
    if (event.type !== "registration") return
    if (leaving || event.state === "unregistered") leaving?.()
    else if (event.state === "registered") update("online")
    else {
      const failure = connectError(event.failure, context)
      if (event.retryIn === undefined) stop(failure)
      else update("reconnecting", failure, Date.now() + event.retryIn)
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

  async function leave(): Promise<void> {
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

  function close(): Promise<void> {
    closing ??= leave()
    return closing
  }

  async function ping(uri = registrar): Promise<Ping> {
    if (leaving || status === "offline") {
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
    subscribe: listeners.subscribe,
    ping,
    close,
    [Symbol.asyncDispose]: close,
  }
}
