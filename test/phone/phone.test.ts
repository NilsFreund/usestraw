import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getHeader, replay } from "../../src/core"
import { openAudio } from "../../src/node/audio"
import type { RingingCall } from "../../src/phone/call"
import { ConnectError } from "../../src/phone/connect-error"
import { toConnectError } from "../../src/phone/failures"
import { type ConnectOptions, type PhoneSettings, resolveOptions } from "../../src/phone/options"
import { type Phone, startPhone } from "../../src/phone/phone"
import type { Link } from "../../src/phone/platform"
import { type MemoryNetwork, memoryNetwork, startOn } from "./memory"

const account = { uri: "sip:alice@example.com", password: "secret" }
const context = { label: "udp://example.com:5060", username: "alice" }
const options = (
  network: MemoryNetwork,
  extra: Partial<ConnectOptions> = {},
  internal: Partial<PhoneSettings> = {},
) =>
  startOn(network, {
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

const SDP =
  "v=0\r\no=- 1 1 IN IP4 192.0.2.20\r\ns=-\r\nc=IN IP4 192.0.2.20\r\nt=0 0\r\nm=audio 4000 RTP/AVP 0\r\n"

const invite = (callId: string) =>
  new TextEncoder().encode(
    [
      "INVITE sip:alice@192.0.2.10 SIP/2.0",
      `Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bK${callId}`,
      "Max-Forwards: 70",
      "From: <sip:bob@example.com>;tag=b1",
      "To: <sip:alice@example.com>",
      `Call-ID: ${callId}`,
      "CSeq: 1 INVITE",
      "Contact: <sip:bob@192.0.2.20>",
      "Content-Type: application/sdp",
      `Content-Length: ${SDP.length}`,
      "",
      SDP,
    ].join("\r\n"),
  )

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
    expect(seen).toStrictEqual([{ status: "closed" }])
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
    expect(phone.error).toStrictEqual(toConnectError({ reason: "timeout" }, context))
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

  it("closes instead of taking the process down when a packet breaks it", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    network.broken = true
    network.inject(
      new TextEncoder().encode(
        [
          "OPTIONS sip:alice@192.0.2.10 SIP/2.0",
          "Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bKbreak",
          "From: <sip:probe@example.com>;tag=p1",
          "To: <sip:alice@example.com>",
          "Call-ID: break-1",
          "CSeq: 1 OPTIONS",
          "Content-Length: 0",
          "",
          "",
        ].join("\r\n"),
      ),
    )
    expect(phone.status).toBe("closed")
    expect(phone.error).toMatchObject({ reason: "network", cause: new Error("The link broke") })
  })

  it("gives up on a silent server after connectTimeout and leaves no timer behind", async () => {
    const network = memoryNetwork()
    network.online = false
    const connecting = options(network, {}, { connectTimeout: 1000 })
    const failed = expect(connecting).rejects.toMatchObject({ reason: "no-answer" })
    await vi.advanceTimersByTimeAsync(1000)
    await failed
    expect(vi.getTimerCount()).toBe(0)
    const refused = memoryNetwork({ users: { alice: "other" } })
    await expect(options(refused)).rejects.toMatchObject({ reason: "wrong-password" })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("registers only in the realm it is given", async () => {
    const network = memoryNetwork({ realm: "corp.example" })
    const settings = resolveOptions({ ...account, realm: "example.com" })
    await expect(startOn(network, settings)).rejects.toMatchObject({
      reason: "unsupported-auth",
      message: expect.stringContaining('in realm "corp.example", not "example.com"'),
    })
  })

  it("ends ringing calls as dropped before it closes for a refused refresh", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    network.inject(invite("ring-1"))
    const [call] = phone.calls
    const seen = watch(phone)
    network.replace({ users: { alice: "changed" } })
    await vi.advanceTimersByTimeAsync(40_000)
    expect(await call?.ended).toStrictEqual({ by: "us", reason: "dropped" })
    expect(seen[0]).toStrictEqual({ status: "online", reason: "wrong-password" })
    expect(seen.at(-1)).toStrictEqual({ status: "closed", reason: "wrong-password" })
  })

  it("keeps its calls and incoming through a lost connection and dials back in", async () => {
    const network = memoryNetwork()
    const phone = await startOn(network, { ...resolveOptions(account), expires: 60 })
    network.inject(invite("lost-1"))
    const iterator = phone.incoming[Symbol.asyncIterator]()
    const { value: call } = await iterator.next()
    const next = iterator.next()
    network.drop(new Error("reset"))
    expect(phone.status).toBe("reconnecting")
    expect(phone.error).toMatchObject({ reason: "network", cause: new Error("reset") })
    expect(call?.status).toBe("ringing")
    await vi.advanceTimersByTimeAsync(1000)
    expect(phone.status).toBe("online")
    expect(phone.calls).toStrictEqual([call])
    expect(network.registrar.registers.map((request) => request.callId)).toStrictEqual(
      Array(network.registrar.registers.length).fill(network.registrar.registers[0]?.callId),
    )
    expect(await Promise.race([next.then(() => "yielded"), Promise.resolve("open")])).toBe("open")
    await closeNow(phone)
    expect(await call?.ended).toStrictEqual({ by: "us", reason: "busy" })
    expect(await next).toStrictEqual({ value: undefined, done: true })
  })

  async function streaming(reopen?: (signal: AbortSignal) => Promise<Link>) {
    const network = memoryNetwork({}, { stream: true })
    const phone = await startOn(
      network,
      { ...resolveOptions(account), expires: 60 },
      reopen ? { connect: reopen } : {},
    )
    return { network, phone }
  }

  it("fails to connect when the connection drops before the registration", async () => {
    const network = memoryNetwork({}, { stream: true })
    network.online = false
    const connecting = startOn(network, resolveOptions(account))
    const failed = expect(connecting).rejects.toMatchObject({ reason: "network" })
    network.drop(new Error("reset"))
    await failed
  })

  it("stays closed when a refused refresh closes its stream connection", async () => {
    const { network, phone } = await streaming()
    network.replace({ users: { alice: "changed" } })
    await vi.advanceTimersByTimeAsync(40_000)
    expect(phone.status).toBe("closed")
    await vi.advanceTimersByTimeAsync(10_000)
    expect(phone.status).toBe("closed")
    expect(phone.error?.reason).toBe("wrong-password")
  })

  it("drops a silent stream connection and dials back in", async () => {
    const { network, phone } = await streaming()
    network.online = false
    await vi.advanceTimersByTimeAsync(70_000)
    expect(network.closed).toBe(true)
    expect(phone.status).toBe("reconnecting")
    network.online = true
    await vi.advanceTimersByTimeAsync(40_000)
    expect(phone.status).toBe("online")
  })

  it("backs off when the connection keeps dropping right after it came back", async () => {
    const { network, phone } = await streaming()
    network.drop()
    const first = (phone.retryAt ?? 0) - Date.now()
    await vi.advanceTimersByTimeAsync(1000)
    expect(phone.status).toBe("online")
    network.drop()
    const second = (phone.retryAt ?? 0) - Date.now()
    expect(first).toBeLessThanOrEqual(1000)
    expect(second).toBeGreaterThanOrEqual(1000)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(61_000)
    network.drop()
    expect((phone.retryAt ?? 0) - Date.now()).toBeLessThanOrEqual(1000)
  })

  it("keeps one trace across connections, and shows no retry time while it dials", async () => {
    const attempt = Promise.withResolvers<Link>()
    const { network, phone } = await streaming(() => attempt.promise)
    network.drop()
    expect(phone.retryAt).toBeDefined()
    await vi.advanceTimersByTimeAsync(1000)
    expect(phone.retryAt).toBeUndefined()
    attempt.resolve(network.link)
    await vi.advanceTimersByTimeAsync(0)
    expect(phone.status).toBe("online")
    const trace = phone.trace ?? ""
    expect(trace.match(/"straw":"recording"/g)).toHaveLength(1)
    expect(replay(trace)).toMatchObject({ ok: true })
  })

  it("sends nothing while it has no connection", async () => {
    const { network, phone } = await streaming()
    network.drop()
    const sent = network.sent
    network.inject(
      new TextEncoder().encode(
        [
          "OPTIONS sip:alice@192.0.2.10 SIP/2.0",
          "Via: SIP/2.0/TLS 192.0.2.20:5061;branch=z9hG4bKgap",
          "From: <sip:probe@example.com>;tag=p1",
          "To: <sip:alice@example.com>",
          "Call-ID: gap-1",
          "CSeq: 1 OPTIONS",
          "Content-Length: 0",
          "",
          "",
        ].join("\r\n"),
      ),
    )
    expect(network.sent).toBe(sent)
    expect(phone.status).toBe("reconnecting")
  })

  it("waits out a registrar that still counts its old binding after a reconnect", async () => {
    const { network, phone } = await streaming()
    network.drop()
    network.replace({ script: [403] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(phone.status).toBe("reconnecting")
    expect(phone.error?.reason).toBe("refused")
    await vi.advanceTimersByTimeAsync(4000)
    expect(phone.status).toBe("online")
  })

  it("takes a refusal after it is back online seriously again", async () => {
    const { network, phone } = await streaming()
    network.drop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(phone.status).toBe("online")
    network.replace({ script: Array(10).fill(403) })
    await vi.advanceTimersByTimeAsync(400_000)
    expect(phone.status).toBe("closed")
    expect(phone.error?.reason).toBe("refused")
  })

  it("does not wait out a wrong password after a reconnect", async () => {
    const { network, phone } = await streaming()
    network.drop()
    network.replace({ users: { alice: "changed" } })
    await vi.advanceTimersByTimeAsync(1000)
    expect(phone.status).toBe("closed")
    expect(phone.error?.reason).toBe("wrong-password")
  })

  it("gives up on a refusing registrar once its old binding must have expired", async () => {
    const { network, phone } = await streaming()
    network.drop()
    network.replace({ script: Array(100).fill(403) })
    await vi.advanceTimersByTimeAsync(590_000)
    expect(phone.status).toBe("reconnecting")
    await vi.advanceTimersByTimeAsync(120_000)
    expect(phone.status).toBe("closed")
    expect(phone.error?.reason).toBe("refused")
  })

  it("tries again after an attempt that fails", async () => {
    let tries = 0
    const network = memoryNetwork({}, { stream: true })
    const phone = await startOn(network, resolveOptions(account), {
      connect: async () => {
        tries += 1
        if (tries === 1) throw new Error("refused")
        return network.link
      },
    })
    network.drop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(phone.status).toBe("reconnecting")
    expect(phone.error).toMatchObject({ cause: new Error("refused") })
    await vi.advanceTimersByTimeAsync(2000)
    expect(tries).toBe(2)
    expect(phone.status).toBe("online")
  })

  it("calls off a reconnect attempt when the phone closes", async () => {
    let signal: AbortSignal | undefined
    const { network, phone } = await streaming(
      (cancel) =>
        new Promise((_, reject) => {
          signal = cancel
          cancel.addEventListener("abort", () => reject(cancel.reason))
        }),
    )
    network.drop()
    await vi.advanceTimersByTimeAsync(1000)
    await closeNow(phone)
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  async function droppedWhileClosing() {
    const network = memoryNetwork()
    const attempt = Promise.withResolvers<Link>()
    const phone = await startOn(
      network,
      { ...resolveOptions(account), expires: 60 },
      { connect: () => attempt.promise },
    )
    network.drop()
    await vi.advanceTimersByTimeAsync(1000)
    await closeNow(phone)
    return { network, attempt, phone }
  }

  it("closes a connection that comes back after the phone closed", async () => {
    const { network, attempt, phone } = await droppedWhileClosing()
    const late = { ...network.link, close: vi.fn() }
    attempt.resolve(late)
    await vi.advanceTimersByTimeAsync(0)
    expect(late.close).toHaveBeenCalledOnce()
    expect(phone.status).toBe("closed")
  })

  it("stops trying when an attempt fails after the phone closed", async () => {
    const { attempt, phone } = await droppedWhileClosing()
    attempt.reject(new Error("refused"))
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(phone.status).toBe("closed")
  })

  it("closes for good when a refresh is refused", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    const seen = watch(phone)
    network.replace({ users: { alice: "changed" } })
    await vi.advanceTimersByTimeAsync(40_000)
    expect(phone.status).toBe("closed")
    expect(network.closed).toBe(true)
    expect(phone.error).toStrictEqual(
      toConnectError({ reason: "unauthorized", status: 401 }, context),
    )
    expect(seen).toStrictEqual([{ status: "closed", reason: "wrong-password" }])
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
    await vi.advanceTimersByTimeAsync(0)
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
    expect(await starting).toStrictEqual(toConnectError({ reason: "timeout" }, context))
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

  it("keeps a trace without the password that replays byte for byte", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    network.inject(incoming())
    await vi.advanceTimersByTimeAsync(300_000)
    await closeNow(phone)
    const recording = phone.trace ?? ""
    expect(recording).not.toContain("secret")
    expect(recording).toContain('response=\\"masked\\"')
    expect(replay(recording)).toMatchObject({ ok: true })
  })

  it("keeps no trace when asked not to", async () => {
    const network = memoryNetwork()
    const phone = await options(network, { trace: false })
    expect(phone.trace).toBeUndefined()
    await closeNow(phone)
  })

  it("still feeds the debug ladder without keeping a trace", async () => {
    const debug = vi.fn()
    const network = memoryNetwork()
    const settings = { ...resolveOptions(account), trace: false }
    const phone = await startOn(network, settings, { debug })
    expect(phone.trace).toBeUndefined()
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ type: "command" }) }),
    )
    await closeNow(phone)
  })
})

describe("phone and its calls", () => {
  const settings = () => ({ ...resolveOptions(account), expires: 60 })

  it("shows only its public fields at runtime", async () => {
    const network = memoryNetwork()
    const platform = { connect: async () => network.link, openAudio }
    const { phone } = await startPhone(network.link, settings(), platform)
    expect(Object.keys(phone).sort()).toStrictEqual([
      "call",
      "calls",
      "close",
      "error",
      "incoming",
      "retryAt",
      "status",
      "subscribe",
      "trace",
    ])
    expect(Object.getOwnPropertySymbols(phone)).toStrictEqual([Symbol.asyncDispose])
    expect(Object.keys(phone.incoming)).toStrictEqual([])
    network.inject(invite("shape-1"))
    expect(Object.keys(phone.calls[0] ?? {}).sort()).toStrictEqual([
      "accept",
      "audio",
      "callerName",
      "direction",
      "end",
      "ended",
      "from",
      "id",
      "ok",
      "reason",
      "status",
      "subscribe",
      "to",
      "toJSON",
    ])
    await closeNow(phone)
  })

  it("ends incoming when a refused refresh closes the phone", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    const next = phone.incoming[Symbol.asyncIterator]().next()
    network.replace({ users: { alice: "changed" } })
    await vi.advanceTimersByTimeAsync(40_000)
    expect(phone.status).toBe("closed")
    expect(await next).toStrictEqual({ value: undefined, done: true })
  })

  it("turns calls and pings away before it tells about a fatal failure", async () => {
    const network = memoryNetwork()
    const phone = await options(network)
    network.inject(invite("fatal-1"))
    const tried: Promise<unknown>[] = []
    phone.subscribe(() => {
      if (!phone.error || tried.length > 0) return
      const name = (thrown: Error) => thrown.name
      tried.push(phone.call("bob").catch(name), phone.ping().catch(name))
    })
    network.replace({ users: { alice: "changed" } })
    await vi.advanceTimersByTimeAsync(40_000)
    expect(await Promise.all(tried)).toStrictEqual(["InvalidStateError", "InvalidStateError"])
    expect(phone.status).toBe("closed")
  })

  it("lets a call that is being answered finish while it drains", async () => {
    const network = memoryNetwork()
    const phone = await startOn(network, settings(), { openAudio: () => new Promise(() => {}) })
    network.inject(invite("drain-1"))
    const ringing = phone.calls[0] as RingingCall
    void ringing.accept()
    let incomingDone = false
    void phone.incoming[Symbol.asyncIterator]()
      .next()
      .then(({ done }) => {
        incomingDone = done === true
      })
    const stop = new AbortController()
    const closing = phone.close({ drain: true, signal: stop.signal })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(phone.calls.map((call) => call.status)).toStrictEqual(["answering"])
    expect(incomingDone).toBe(true)
    stop.abort()
    await vi.advanceTimersByTimeAsync(10_000)
    await closing
    expect(await ringing.ended).toStrictEqual({ by: "us", reason: "busy" })
  })

  it("opens audio on the address of the connection it has now", async () => {
    const network = memoryNetwork()
    const hosts: string[] = []
    const moved = { ...network.link, local: { ...network.link.local, host: "198.51.100.7" } }
    const phone = await startOn(network, settings(), {
      connect: async () => moved,
      openAudio: (host) => {
        hosts.push(host)
        return new Promise(() => {})
      },
    })
    network.drop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(phone.status).toBe("online")
    network.inject(invite("moved-1"))
    void (phone.calls[0] as RingingCall).accept()
    expect(hosts).toStrictEqual(["198.51.100.7"])
    await closeNow(phone)
  })
})

describe("phone on a trunk", () => {
  const trunk = { register: false } as const
  const at = (host: string) => ({ transport: "UDP", host, port: 5060 }) as const
  const streamed = async () => {
    const network = memoryNetwork({}, { stream: true })
    const settings = resolveOptions({ ...account, ...trunk })
    const phone = await startOn(network, settings)
    return { network, phone }
  }

  it("goes online once the server answers, and never registers", async () => {
    const network = memoryNetwork()
    const phone = await options(network, trunk)
    expect(phone.status).toBe("online")
    expect(network.sent).toBe(1)
    await closeNow(phone)
    expect(network.sent).toBe(1)
    expect(network.registrar.registers).toStrictEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("takes any answer as a sign of life", async () => {
    const network = memoryNetwork({ optionsStatus: 405 })
    const phone = await options(network, trunk)
    expect(phone.status).toBe("online")
    await closeNow(phone)
  })

  it("fails as no-answer when the server stays silent", async () => {
    const network = memoryNetwork()
    network.online = false
    const starting = options(network, trunk).catch((thrown: unknown) => thrown)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await starting).toStrictEqual(toConnectError({ reason: "timeout" }, context))
  })

  it("checks the server every minute and reports it gone until it answers again", async () => {
    const network = memoryNetwork()
    const phone = await options(network, trunk)
    const seen = watch(phone)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(network.sent).toBe(2)
    network.online = false
    await vi.advanceTimersByTimeAsync(92_001)
    expect(phone.status).toBe("reconnecting")
    expect(phone.error?.reason).toBe("no-answer")
    const retryAt = phone.retryAt ?? 0
    expect(retryAt - Date.now()).toBeLessThanOrEqual(1000)
    network.online = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(phone.status).toBe("online")
    expect(seen).toStrictEqual([
      { status: "reconnecting", reason: "no-answer", retryAt },
      { status: "reconnecting", reason: "no-answer" },
      { status: "online" },
    ])
    expect(network.registrar.registers).toStrictEqual([])
    await closeNow(phone)
  })

  it("stays closed when it closes while a ping is out", async () => {
    const network = memoryNetwork()
    const phone = await options(network, trunk)
    network.online = false
    await vi.advanceTimersByTimeAsync(60_000)
    await closeNow(phone)
    expect(phone.status).toBe("closed")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("leaves no timer behind when closed while it waits to check again", async () => {
    const network = memoryNetwork()
    const phone = await options(network, trunk)
    network.online = false
    await vi.advanceTimersByTimeAsync(92_001)
    expect(phone.retryAt).toBeDefined()
    await closeNow(phone)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("drops a stream connection whose server stops answering, and checks once a minute again after dialing back in", async () => {
    const { network, phone } = await streamed()
    network.online = false
    await vi.advanceTimersByTimeAsync(92_001)
    expect(network.closed).toBe(true)
    expect(phone.status).toBe("reconnecting")
    network.online = true
    await vi.advanceTimersByTimeAsync(2000)
    expect(phone.status).toBe("online")
    const sent = network.sent
    await vi.advanceTimersByTimeAsync(60_000)
    expect(network.sent).toBe(sent + 1)
    await closeNow(phone)
  })

  it("stops checking once closed", async () => {
    const { network, phone } = await streamed()
    network.online = false
    network.drop()
    await vi.advanceTimersByTimeAsync(1000)
    await closeNow(phone)
    const sent = network.sent
    await vi.advanceTimersByTimeAsync(120_000)
    expect(network.sent).toBe(sent)
    expect(phone.status).toBe("closed")
  })

  it("takes requests from the listed ranges besides the server, and from nobody else", async () => {
    const network = memoryNetwork()
    const phone = await options(network, { ...trunk, acceptFrom: ["198.51.100.0/24"] })
    const sent = network.destinations.length
    network.inject(incoming("198.51.100.7:5060"), at("198.51.100.7"))
    network.inject(incoming("203.0.113.9:5060"), at("203.0.113.9"))
    network.inject(incoming())
    expect(network.destinations.slice(sent).map((to) => to.host)).toStrictEqual([
      "198.51.100.7",
      "192.0.2.20",
    ])
    await closeNow(phone)
  })

  it("closes its link when the core refuses the settings", async () => {
    const network = memoryNetwork()
    const settings = { ...resolveOptions(account), acceptFrom: ["nowhere"] }
    await expect(startOn(network, settings)).rejects.toThrow(TypeError)
    expect(network.closed).toBe(true)
  })
})
