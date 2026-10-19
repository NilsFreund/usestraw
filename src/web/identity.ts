import { createInstanceId, isInstanceId } from "../core/ids"
import { invalidHost } from "../phone/websocket"
import type { Random } from "../support/random"

export interface Identity {
  readonly host: string
  readonly instance: string
}

// Frees the saved identity for the next phone in the tab, once this one has unregistered
export interface Claimed extends Identity {
  release(): void
}

interface Tab {
  readonly claimed: Promise<boolean>
  taken: boolean
}

const KEY = "usestraw:identity"
const HOST = /^[a-z0-9]{12}\.invalid$/
const tabs = new WeakMap<LockManager, Tab>()

// A reload registers the same Contact and instance, so the registrar replaces the old binding. One
// phone in one tab holds the saved identity at a time; any other registers beside it with its own.
// Without Web Locks every tab would take it, so none does.
export async function identityFor(
  storage: Storage | undefined,
  locks: LockManager | undefined,
  random: Random,
): Promise<Claimed> {
  const fresh = { host: invalidHost(random), instance: createInstanceId(random) }
  const tab = locks && claim(locks)
  if (!tab || !(await tab.claimed) || tab.taken) return { ...fresh, release: () => undefined }
  tab.taken = true
  let holding = true
  const release = () => {
    if (holding) tab.taken = false
    holding = false
  }
  const saved = read(storage)
  if (saved) return { ...saved, release }
  try {
    storage?.setItem(KEY, JSON.stringify(fresh))
  } catch {
    // Private windows and full storage only cost the replacement after a reload
  }
  return { ...fresh, release }
}

// The tab keeps the lock until it closes or navigates away
function claim(locks: LockManager): Tab {
  let tab = tabs.get(locks)
  if (!tab) {
    const claimed = new Promise<boolean>((resolve) => {
      locks
        .request(KEY, { ifAvailable: true }, (lock) => {
          resolve(lock !== null)
          return lock && new Promise<never>(() => undefined)
        })
        .catch(() => resolve(false))
    })
    tab = { claimed, taken: false }
    tabs.set(locks, tab)
  }
  return tab
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
