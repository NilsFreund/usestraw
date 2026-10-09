import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getHeader } from "../../src"
import { ConnectError, connectError } from "../../src/node/errors"
import { type ConnectOptions, type PhoneSettings, resolveOptions } from "../../src/node/options"
import { type Phone, startPhone } from "../../src/node/phone"
import { type MemoryNetwork, memoryNetwork } from "./memory"

const account = { uri: "sip:alice@example.com", password: "secret" }
const context = { label: "udp://example.com:5060", username: "alice" }
const options = (
  network: MemoryNetwork,
  extra: Partial<ConnectOptions> = {},
  internal: Partial<PhoneSettings> = {},
) =>
  startPhone(network.link, {
    ...resolveOptions({ ...account, ...extra }),
    expires: 60,
    ...internal,
  })

function watch(phone: Phone) {
  const seen: { status: string; reason?: string; retryAt?: number }[] = []
  phone.subscribe(() =>
    seen.push({
      status: phone.status,
      ...(phone.error ? { reason: phone.error.reason } : {}),
      ...(phone.retryAt === undefined ? {} : { retryAt: phone.retryAt }),
    }),
  )
  return seen
}

async function closeNow(phone: Phone): Promise<void> {
  const closing = phone.close()
  await vi.advanceTimersByTimeAsync(0)
  await closing
}

const incoming = (via = "192.0.2.20:5060") =>
  new TextEncoder().encode(
    [
      "OPTIONS sip:alice@example.com SIP/2.0",
      `Via: SIP/2.0/UDP ${via};branch=z9hG4bK1`,
      "From: <sip:bob@example.com>;tag=b1",
      "To: <sip:alice@example.com>",
      "Call-ID: in-1",
      "CSeq: 1 OPTIONS",
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n"),
  )

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("phone status", () => {
  it("stays quiet while refreshes succeed", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    const seen = watch(phone)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(network.registrar.registers.length).toBeGreaterThanOrEqual(20)
    expect(phone.status).toBe("online")
    expect(seen).toStrictEqual([])
    await closeNow(phone)
    expect(seen).toStrictEqual([{ status: "offline" }])
  })

  it("reports reconnecting while the registrar is gone and online once it is back", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    const first = watch(phone)
    const second = watch(phone)
    let failedAt = 0
    phone.subscribe(() => {
      failedAt = Date.now()
    })
    network.online = false
    await vi.advanceTimersByTimeAsync(70_000)
    expect(phone.status).toBe("reconnecting")
    expect(phone.error).toStrictEqual(connectError({ reason: "timeout" }, context))
    expect(phone.error?.reason).toBe("no-answer")
    const retryAt = phone.retryAt ?? 0
    expect(retryAt - failedAt).toBeGreaterThanOrEqual(30_000)
    expect(retryAt - failedAt).toBeLessThanOrEqual(60_000)
    expect(first).toStrictEqual([{ status: "reconnecting", reason: "no-answer", retryAt }])
    expect(second).toStrictEqual(first)
    network.online = true
    await vi.advanceTimersByTimeAsync(120_000)
    expect(phone.status).toBe("online")
    expect(phone.error).toBeUndefined()
    expect(phone.retryAt).toBeUndefined()
    expect(first.at(-1)).toStrictEqual({ status: "online" })
    await closeNow(phone)
  })

  it("closes for good when a refresh is refused", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    const seen = watch(phone)
    network.replace({ users: { alice: "changed" } })
    await vi.advanceTimersByTimeAsync(40_000)
    expect(phone.status).toBe("offline")
    expect(network.closed).toBe(true)
    expect(phone.error).toStrictEqual(
      connectError({ reason: "unauthorized", status: 401 }, context),
    )
    expect(seen).toStrictEqual([{ status: "offline", reason: "wrong-password" }])
    await expect(phone.ping()).rejects.toThrow("The phone is closed")
    await phone.close()
    expect(phone.error?.reason).toBe("wrong-password")
    expect(seen).toHaveLength(1)
    expect(network.registrar.registers).toHaveLength(2)
  })

  it("unregisters on close while reconnecting", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    network.online = false
    await vi.advanceTimersByTimeAsync(70_000)
    expect(phone.status).toBe("reconnecting")
    network.online = true
    await phone.close()
    expect(phone.error).toBeUndefined()
    expect(phone.retryAt).toBeUndefined()
    const expires = network.registrar.registers.map((request) => getHeader(request, "Expires"))
    expect(expires.slice(-2)).toStrictEqual(["0", "0"])
    expect(network.registrar.bindings.size).toBe(0)
  })

  it("waits five seconds for the unregister by default", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    network.online = false
    let closed = false
    const closing = phone.close().then(() => {
      closed = true
    })
    await vi.advanceTimersByTimeAsync(4999)
    expect(closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await closing
    expect(closed).toBe(true)
  })

  it("stops sending once closed", async () => {
    const network = memoryNetwork()
    const phone = await options(network, {}, { closeTimeout: 100 })
    network.online = false
    const closing = phone.close()
    await vi.advanceTimersByTimeAsync(100)
    await closing
    const sent = network.sent
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(network.sent).toBe(sent)
  })

  it("refuses pings once closing has started", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    network.online = false
    const closing = phone.close()
    const sent = network.sent
    await expect(phone.ping()).rejects.toMatchObject({ name: "InvalidStateError" })
    expect(network.sent).toBe(sent)
    await vi.advanceTimersByTimeAsync(5000)
    await closing
  })

  it("leaves no timer behind once closed", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    await phone.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("stops waiting once the registrar refuses the unregister", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    network.replace({ script: [403] })
    let closed = false
    const closing = phone.close().then(() => {
      closed = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(closed).toBe(true)
    await closing
  })

  it("waits as long as Retry-After asks while reconnecting", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    network.replace({ script: [503], retryAfter: 120 })
    let failedAt = 0
    phone.subscribe(() => {
      failedAt = Date.now()
    })
    await vi.advanceTimersByTimeAsync(40_000)
    expect(phone.status).toBe("reconnecting")
    expect([phone.error?.reason, phone.error?.sip]).toStrictEqual(["unavailable", { status: 503 }])
    expect(phone.retryAt).toBe(failedAt + 120_000)
    await closeNow(phone)
  })

  it("measures the round trip from when the ping was sent", async () => {
    const network = memoryNetwork()
    const phone = await options(network, {}, { expires: 3600 })
    await vi.advanceTimersByTimeAsync(10_000)
    network.online = false
    const ping = phone.ping("sip:bob@example.com")
    await vi.advanceTimersByTimeAsync(400)
    network.online = true
    await vi.advanceTimersByTimeAsync(200)
    expect(await ping).toStrictEqual({ status: 200, rtt: 500 })
    await closeNow(phone)
  })

  it("answers a request at the address in its Via", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    network.inject(incoming("192.0.2.20:5070"))
    expect(network.destinations.at(-1)).toStrictEqual({
      transport: "UDP",
      host: "192.0.2.20",
      port: 5070,
    })
    await closeNow(phone)
  })

  it("reports a registrar that never answers", async () => {
    const network = memoryNetwork()
    network.online = false
    const starting = options(network).catch((thrown: unknown) => thrown)
    await vi.advanceTimersByTimeAsync(32_000)
    expect(await starting).toStrictEqual(connectError({ reason: "timeout" }, context))
    expect(network.closed).toBe(true)
  })

  it("closes the link when the first registration fails", async () => {
    const network = memoryNetwork()
    await expect(options(network, { password: "wrong" })).rejects.toThrow(ConnectError)
    expect(network.closed).toBe(true)
  })

  it("does not start when the signal has already aborted", async () => {
    const network = memoryNetwork()
    const signal = AbortSignal.abort()
    await expect(options(network, { signal })).rejects.toBe(signal.reason)
    expect(network.sent).toBe(0)
    expect(network.closed).toBe(true)
  })

  it("times out a ping nobody answers", async () => {
    const network = memoryNetwork()
    const phone = await options(network, {}, { expires: 3600 })
    network.online = false
    const pinging = phone.ping().catch((thrown: unknown) => thrown)
    await vi.advanceTimersByTimeAsync(32_000)
    expect(await pinging).toMatchObject({
      name: "TimeoutError",
      message: "No answer to OPTIONS sip:example.com",
    })
    network.online = true
    await closeNow(phone)
  })

  it("answers requests while registered and ignores them after close", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    const sent = network.sent
    network.inject(incoming())
    expect(network.sent).toBe(sent + 1)
    await closeNow(phone)
    const closedSent = network.sent
    network.inject(incoming())
    expect(network.sent).toBe(closedSent)
  })

  it("tells about every new failure while it stays reconnecting", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    const seen = watch(phone)
    network.online = false
    await vi.advanceTimersByTimeAsync(70_000 + 60_000 + 32_000)
    expect(seen.map(({ status, reason }) => [status, reason])).toStrictEqual([
      ["reconnecting", "no-answer"],
      ["reconnecting", "no-answer"],
    ])
    expect(seen[1]?.retryAt).toBeGreaterThan(seen[0]?.retryAt ?? 0)
    network.online = true
    await closeNow(phone)
  })
})
