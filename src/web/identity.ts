import { createInstanceId, isInstanceId } from "../core/ids"
import { invalidHost } from "../phone/websocket"
import type { Random } from "../support/random"

export interface Identity {
  readonly host: string
  readonly instance: string
}

const KEY = "usestraw:identity"
const HOST = /^[a-z0-9]{12}\.invalid$/
const claims = new WeakMap<LockManager, Promise<boolean>>()

// A reload registers the same Contact and instance, so the registrar replaces the old binding. One
// tab holds the saved identity at a time: a second tab registers beside it with one of its own.
export async function identityFor(
  storage: Storage | undefined,
  locks: LockManager | undefined,
  random: Random,
): Promise<Identity> {
  const fresh = { host: invalidHost(random), instance: createInstanceId(random) }
  if (locks && !(await claim(locks))) return fresh
  const saved = read(storage)
  if (saved) return saved
  try {
    storage?.setItem(KEY, JSON.stringify(fresh))
  } catch {
    // Private windows and full storage only cost the replacement after a reload
  }
  return fresh
}

// The tab keeps the lock until it closes or navigates away
function claim(locks: LockManager): Promise<boolean> {
  let claimed = claims.get(locks)
  if (!claimed) {
    claimed = new Promise((resolve) => {
      locks
        .request(KEY, { ifAvailable: true }, (lock) => {
          resolve(lock !== null)
          return lock && new Promise<never>(() => undefined)
        })
        .catch(() => resolve(false))
    })
    claims.set(locks, claimed)
  }
  return claimed
}

function read(storage: Storage | undefined): Identity | undefined {
  try {
    const value: unknown = JSON.parse(storage?.getItem(KEY) ?? "null")
    if (typeof value !== "object" || value === null) return undefined
    const { host, instance } = value as Record<string, unknown>
    if (
      typeof host === "string" &&
      HOST.test(host) &&
      typeof instance === "string" &&
      isInstanceId(instance)
    ) {
      return { host, instance }
    }
  } catch {
    // A broken entry gets replaced
  }
  return undefined
}

// Sandboxed frames throw on the very access to localStorage
export function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function browserLocks(): LockManager | undefined {
  return globalThis.navigator?.locks
}
