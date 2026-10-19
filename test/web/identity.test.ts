import { afterEach, describe, expect, it, vi } from "vitest"
import { createRandom } from "../../src/simulation/random"
import { browserLocks, browserStorage, type Claimed, identityFor } from "../../src/web/identity"
import { fakeLocks, fakeStorage } from "./fakes"

const KEY = "usestraw:identity"
const plain = ({ host, instance }: { host: string; instance: string }) => ({ host, instance })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("identityFor", () => {
  it("draws a host and an instance once and keeps them across reloads", async () => {
    const storage = fakeStorage()
    const first = plain(await identityFor(storage, fakeLocks(), createRandom(1)))
    expect(first.host).toMatch(/^[a-z0-9]{12}\.invalid$/)
    expect(first.instance).toMatch(/^urn:uuid:[\da-f]{8}-[\da-f]{4}-4/)
    expect(plain(await identityFor(storage, fakeLocks(), createRandom(2)))).toStrictEqual(first)
    expect(JSON.parse(storage.entries[KEY] ?? "")).toStrictEqual(first)
  })

  it("gives a second tab an identity of its own", async () => {
    const storage = fakeStorage()
    const held = new Set<string>()
    const first = await identityFor(storage, fakeLocks(held), createRandom(1))
    const other = await identityFor(storage, fakeLocks(held), createRandom(2))
    expect(other.instance).not.toBe(first.instance)
    expect(other.host).not.toBe(first.host)
    expect(JSON.parse(storage.entries[KEY] ?? "")).toStrictEqual(plain(first))
  })

  it("lends the saved identity to one phone in a tab at a time, also when two connect at once", async () => {
    const storage = fakeStorage()
    const tab = fakeLocks()
    const [first, second] = await Promise.all([
      identityFor(storage, tab, createRandom(1)),
      identityFor(storage, tab, createRandom(2)),
    ])
    expect(second?.instance).not.toBe(first?.instance)
    second?.release()
    expect((await identityFor(storage, tab, createRandom(3))).instance).not.toBe(first?.instance)
    first?.release()
    first?.release()
    const next = await identityFor(storage, tab, createRandom(4))
    expect(plain(next)).toStrictEqual(plain(first as Claimed))
    first?.release()
    expect((await identityFor(storage, tab, createRandom(5))).instance).not.toBe(next.instance)
  })

  it("holds the lock for as long as the tab lives", async () => {
    let released = false
    const locks = {
      request: (_: string, __: LockOptions, callback: LockGrantedCallback<unknown>) =>
        Promise.resolve(callback({ name: KEY, mode: "exclusive" })).then(() => {
          released = true
        }),
    } as unknown as LockManager
    await identityFor(fakeStorage(), locks, createRandom(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(released).toBe(false)
  })

  it("keeps to a fresh identity where locks fail or don't exist", async () => {
    const storage = fakeStorage()
    const saved = await identityFor(storage, fakeLocks(), createRandom(1))
    const failing = {
      request: () => Promise.reject(new DOMException("opaque origin", "SecurityError")),
    } as unknown as LockManager
    expect((await identityFor(storage, failing, createRandom(2))).instance).not.toBe(saved.instance)
    const lockless = await identityFor(storage, undefined, createRandom(3))
    expect(lockless.instance).not.toBe(saved.instance)
    expect(() => lockless.release()).not.toThrow()
    expect(JSON.parse(storage.entries[KEY] ?? "")).toStrictEqual(plain(saved))
  })

  it.each([
    ["not JSON", "{"],
    ["null", "null"],
    ["a number", "1"],
    [
      "a wrong host",
      JSON.stringify({
        host: "evil.example.com",
        instance: "urn:uuid:00000000-0000-4000-8000-000000000000",
      }),
    ],
    [
      "a short host",
      JSON.stringify({
        host: "x.invalid",
        instance: "urn:uuid:00000000-0000-4000-8000-000000000000",
      }),
    ],
    ["a wrong instance", JSON.stringify({ host: "abcdefghijkl.invalid", instance: "x" })],
  ])("replaces an entry that is %s", async (_, saved) => {
    const storage = fakeStorage({ [KEY]: saved })
    const fresh = plain(await identityFor(storage, fakeLocks(), createRandom(1)))
    expect(fresh).toStrictEqual(
      plain(await identityFor(fakeStorage(), fakeLocks(), createRandom(1))),
    )
    expect(JSON.parse(storage.entries[KEY] ?? "")).toStrictEqual(fresh)
  })

  it("works without storage, and when storage refuses to read or write", async () => {
    expect((await identityFor(undefined, fakeLocks(), createRandom(1))).host).toMatch(/\.invalid$/)
    const broken = fakeStorage()
    broken.getItem = () => {
      throw new DOMException("denied", "SecurityError")
    }
    broken.setItem = () => {
      throw new DOMException("full", "QuotaExceededError")
    }
    expect((await identityFor(broken, fakeLocks(), createRandom(1))).instance).toMatch(/^urn:uuid:/)
  })
})

describe("browserStorage", () => {
  it("is the browser's localStorage, or nothing where touching it throws", () => {
    const storage = fakeStorage()
    vi.stubGlobal("localStorage", storage)
    expect(browserStorage()).toBe(storage)
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("denied", "SecurityError")
      },
    })
    expect(browserStorage()).toBeUndefined()
  })
})

describe("browserLocks", () => {
  it("is the browser's lock manager, or nothing without one", () => {
    const locks = fakeLocks()
    vi.stubGlobal("navigator", { locks })
    expect(browserLocks()).toBe(locks)
    vi.stubGlobal("navigator", undefined)
    expect(browserLocks()).toBeUndefined()
  })
})
