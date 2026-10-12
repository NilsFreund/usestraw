import type { TransportAddress } from "../transport/address"
import type { Clock } from "./clock"
import { toConnectError } from "./failures"
import type { PhoneSettings } from "./options"
import type { Link, Platform } from "./platform"

export interface ConnectionSetup {
  readonly first: Link
  readonly platform: Platform
  readonly clock: Clock
  readonly connectTimeout: number
  /** Aborts when the phone stops: a link that arrives after that is closed at once. */
  readonly cancel: AbortSignal
  readonly receive: (data: Uint8Array, from: TransportAddress) => void
  /** A link is up and receiving; `link` already points at it. */
  readonly opened: () => void
  readonly lost: (cause?: Error) => void
  readonly failed: (cause: unknown) => void
}

/** The phone's link to its server, replaced by a new one after it breaks. */
export interface Connection {
  readonly link: Link
  readonly connected: boolean
  /** When the current link came back after a reconnect, until the phone is online again. */
  readonly resumedAt: number | undefined
  /** Starts on the first link. */
  start(): void
  dial(): void
  online(): void
  send(data: Uint8Array, to: TransportAddress): void
}

// The first link, before there is a phone: a failure here rejects connect()
export async function connectFirst(settings: PhoneSettings, platform: Platform): Promise<Link> {
  const { signal, connectTimeout, label, username } = settings
  signal?.throwIfAborted()
  const timeout = AbortSignal.timeout(connectTimeout)
  const connecting = signal ? AbortSignal.any([signal, timeout]) : timeout
  return platform.connect(connecting).catch((error: unknown) => {
    signal?.throwIfAborted()
    const cause = timeout.aborted ? timeout.reason : error
    throw toConnectError({ reason: "network" }, { label, username }, cause)
  })
}

export function createConnection(setup: ConnectionSetup): Connection {
  const { platform, clock, connectTimeout, cancel, receive, opened, lost, failed } = setup
  let link = setup.first
  let connected = false
  let resumedAt: number | undefined

  function use(next: Link): void {
    link = next
    connected = true
    next.start({ receive, close: broke })
    opened()
  }

  function broke(cause?: Error): void {
    connected = false
    lost(cause)
  }

  function dial(): void {
    platform.connect(AbortSignal.any([cancel, AbortSignal.timeout(connectTimeout)])).then(
      (next) => {
        if (cancel.aborted) {
          next.close()
          return
        }
        resumedAt = clock.now()
        use(next)
      },
      (thrown: unknown) => {
        if (!cancel.aborted) failed(thrown)
      },
    )
  }

  return {
    get link() {
      return link
    },
    get connected() {
      return connected
    },
    get resumedAt() {
      return resumedAt
    },
    start: () => use(setup.first),
    dial,
    online: () => {
      resumedAt = undefined
    },
    send: (data, to) => {
      if (connected) link.send(data, to)
    },
  }
}
