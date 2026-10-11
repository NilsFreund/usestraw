import { createSocket } from "node:dgram"
import { once } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getHeader, replay } from "../../src"
import { ConnectError, type ConnectOptions, connect, type Phone } from "../../src/node"
import { type PhoneSettings, resolveOptions } from "../../src/node/options"
import { connectPhone, type PhoneHandle } from "../../src/node/phone"
import {
  certificate,
  closedPort,
  silentServer,
  type TestServer,
  tlsRegistrar,
  udpRegistrar,
} from "./servers"

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function serve(server: Promise<TestServer>): Promise<TestServer> {
  const started = await server
  cleanups.push(() => started.close())
  return started
}

function options(server: TestServer, transport: "udp" | "tls"): ConnectOptions {
  return {
    uri: "sip:alice@example.com",
    password: "secret",
    server: `${transport}://${transport === "tls" ? "localhost" : "127.0.0.1"}:${server.port}`,
    ...(transport === "tls" ? { tls: { ca: certificate } } : {}),
  }
}

async function phoneFor(
  settings: ConnectOptions,
  internal: Partial<PhoneSettings> = {},
): Promise<PhoneHandle> {
  const phone = await connectPhone({ ...resolveOptions(settings), ...internal })
  cleanups.push(() => phone.close())
  return phone
}

async function failure(settings: ConnectOptions): Promise<ConnectError> {
  const error = await connect(settings).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  if (!(error instanceof ConnectError)) throw new Error(`Expected a ConnectError`)
  return error
}

function watch(phone: Phone): { status: string; error?: string }[] {
  const seen: { status: string; error?: string }[] = []
  phone.subscribe(() =>
    seen.push({ status: phone.status, ...(phone.error ? { error: phone.error.message } : {}) }),
  )
  return seen
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function expiries(server: TestServer): (string | undefined)[] {
  const branches = new Set<string | null | undefined>()
  return server.registrar.registers.flatMap((request) => {
    const branch = request.via[0]?.params.get("branch")
    if (branches.has(branch)) return []
    branches.add(branch)
    return [getHeader(request, "Expires")]
  })
}

describe.each(["udp", "tls"] as const)("connect over %s", (transport) => {
  const start = (settings = {}) =>
    serve(transport === "tls" ? tlsRegistrar(settings) : udpRegistrar(settings))

  it("resolves once registered and unregisters on close", async () => {
    const server = await start({ algorithm: "SHA-256" })
    const phone = await phoneFor(options(server, transport), { expires: 120 })
    const seen = watch(phone)
    expect(phone.status).toBe("online")
    expect(phone.error).toBeUndefined()
    expect(server.registrar.bindings.size).toBe(1)
    const started = performance.now()
    await phone.close()
    expect(performance.now() - started).toBeLessThan(1000)
    expect(phone.status).toBe("offline")
    expect(server.registrar.bindings.size).toBe(0)
    expect(expiries(server)).toStrictEqual(["120", "120", "0", "0"])
    expect(seen).toStrictEqual([{ status: "offline" }])
  })

  it("registers its real local address", async () => {
    const server = await start()
    await phoneFor(options(server, transport))
    const [request] = server.registrar.registers
    expect(request?.via[0]?.transport).toBe(transport.toUpperCase())
    expect(["127.0.0.1", "[::1]"]).toContain(request?.via[0]?.host)
    expect(String(request?.via[0]?.port)).toBe(request?.via[0]?.params.get("rport"))
  })

  it("pings the registrar or any uri through the server", async () => {
    const server = await start()
    const phone = await phoneFor(options(server, transport))
    const pinged = await phone.ping()
    expect(pinged.status).toBe(200)
    expect(pinged.rtt).toBeLessThan(1000)
    expect((await phone.ping("sip:bob@example.com")).status).toBe(200)
  })

  it("refuses to register without a password", async () => {
    const server = await start()
    const { password: _, ...settings } = options(server, transport)
    const error = await failure(settings)
    expect(error.reason).toBe("password-missing")
    expect(error.message).toMatch(/ asks for a password, but none was given$/)
  })

  it("refuses to register with a wrong password", async () => {
    const server = await start()
    const error = await failure({ ...options(server, transport), password: "wrong" })
    expect([error.reason, error.sip]).toStrictEqual(["wrong-password", { status: 401 }])
    expect(error.message).toContain('refused the password for "alice" with 401')
  })

  it("refuses to register when the registrar rejects the first attempt", async () => {
    const server = await start({ script: [503], retryAfter: 60 })
    const error = await failure(options(server, transport))
    expect([error.reason, error.sip]).toStrictEqual(["unavailable", { status: 503 }])
    expect(error.message).toMatch(/ rejected the registration with 503 "Scripted"$/)
  })

  it("refuses invalid options before it connects", async () => {
    const server = await start()
    await expect(connect({ ...options(server, transport), password: "a\r\nb" })).rejects.toThrow(
      TypeError,
    )
    await pause(50)
    expect(server.received).toBe(0)
    expect(server.sockets).toHaveLength(0)
  })

  it("gives up waiting for the unregister after the close timeout", async () => {
    const server = await start()
    const phone = await phoneFor(options(server, transport), { closeTimeout: 50 })
    server.mute()
    const started = performance.now()
    await phone.close()
    expect(performance.now() - started).toBeGreaterThanOrEqual(45)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(phone.status).toBe("offline")
  })

  it("rejects pings after close and pings still waiting at close", async () => {
    const server = await start()
    const phone = await phoneFor(options(server, transport), { closeTimeout: 50 })
    server.mute()
    const waiting = phone.ping()
    const closing = phone.close()
    await expect(phone.ping()).rejects.toMatchObject({ name: "InvalidStateError" })
    await closing
    await expect(waiting).rejects.toThrow("The phone is closed")
    await expect(phone.ping()).rejects.toThrow("The phone is closed")
  })

  it("gives up when aborted while it waits for the registrar", async () => {
    const server = await start()
    server.mute()
    const signal = AbortSignal.timeout(50)
    await expect(connect({ ...options(server, transport), signal })).rejects.toMatchObject({
      name: "TimeoutError",
    })
    const received = server.received
    await pause(600)
    expect(server.received).toBe(received)
  })

  it("closes and unregisters when the signal aborts after connecting", async () => {
    const server = await start()
    const controller = new AbortController()
    const phone = await phoneFor({ ...options(server, transport), signal: controller.signal })
    const seen = watch(phone)
    controller.abort()
    await vi.waitFor(() => expect(phone.status).toBe("offline"))
    expect(phone.error).toBeUndefined()
    expect(seen).toStrictEqual([{ status: "offline" }])
    await vi.waitFor(() => expect(server.registrar.bindings.size).toBe(0))
  })
})

describe("connect", () => {
  it("connects to a trunk without registering, and takes calls at its fixed port", async () => {
    const server = await serve(udpRegistrar())
    const probe = createSocket("udp4")
    await new Promise<void>((resolve) => probe.bind(0, "127.0.0.1", resolve))
    const port = probe.address().port
    probe.close()
    const phone = await phoneFor({ ...options(server, "udp"), register: false, localPort: port })
    expect(phone.status).toBe("online")
    expect(server.registrar.registers).toStrictEqual([])
    const trunk = createSocket("udp4")
    cleanups.push(() => new Promise((resolve) => trunk.close(() => resolve())))
    const answered = once(trunk, "message")
    trunk.send(
      [
        `OPTIONS sip:alice@127.0.0.1:${port} SIP/2.0`,
        "Via: SIP/2.0/UDP 127.0.0.1:5999;rport;branch=z9hG4bKtrunk",
        "From: <sip:trunk@example.com>;tag=t1",
        "To: <sip:alice@example.com>",
        "Call-ID: trunk-1",
        "CSeq: 1 OPTIONS",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"),
      port,
      "127.0.0.1",
    )
    const [reply] = (await answered) as [Buffer]
    expect(reply.toString().split("\r\n", 1)[0]).toBe("SIP/2.0 200 OK")
    await phone.close()
    expect(server.registrar.registers).toStrictEqual([])
  })

  it("derives a UDP server from a sip uri", async () => {
    const server = await serve(udpRegistrar())
    const phone = await phoneFor({ uri: `sip:alice@127.0.0.1:${server.port}`, password: "secret" })
    expect(phone.status).toBe("online")
  })

  it("derives a TLS server from a sips uri", async () => {
    const server = await serve(tlsRegistrar())
    const phone = await phoneFor({
      uri: `sips:alice@localhost:${server.port}`,
      password: "secret",
      tls: { ca: certificate },
    })
    expect(phone.status).toBe("online")
    expect(server.registrar.registers[0]?.uri).toBe(`sips:localhost:${server.port}`)
  })

  it("uses the username instead of the user part of the uri", async () => {
    const server = await serve(udpRegistrar({ users: { a1: "secret" } }))
    const phone = await phoneFor({ ...options(server, "udp"), authUser: "a1" })
    expect(phone.status).toBe("online")
  })

  it("asks for a URL when the variable behind it is unset", async () => {
    await expect(connect(process.env["STRAW_URL_THAT_IS_NOT_SET"])).rejects.toThrow(
      "Missing connection URL: pass tls://user:password@host[:port]",
    )
  })

  it("lets go of its signal once it is offline", async () => {
    const server = await serve(udpRegistrar())
    const controller = new AbortController()
    const removed = vi.spyOn(controller.signal, "removeEventListener")
    const phone = await phoneFor({ ...options(server, "udp"), signal: controller.signal })
    await phone.close()
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function))
  })

  it("refuses invalid options", async () => {
    await expect(connect({ uri: "alice" })).rejects.toThrow('Invalid uri "alice"')
    await expect(connect({ uri: "sip:alice@example.com", server: "x" })).rejects.toThrow(
      'Invalid server "x"',
    )
  })

  it("does not start when the signal has already aborted", async () => {
    const server = await serve(udpRegistrar())
    const signal = AbortSignal.abort()
    await expect(connect({ ...options(server, "udp"), signal })).rejects.toBe(signal.reason)
    await pause(50)
    expect(server.received).toBe(0)
  })

  it("reports an untrusted certificate as a network error with a hint", async () => {
    const server = await serve(tlsRegistrar())
    const error = await failure({
      uri: "sip:alice@example.com",
      server: `tls://localhost:${server.port}`,
    })
    expect(error.reason).toBe("network")
    expect(error.cause).toBeInstanceOf(Error)
    expect(error.message).toMatch(
      /^Network error with tls:\/\/localhost:\d+: .*certificate.* \(pass tls\.ca if the server uses a private CA\)$/,
    )
  })

  it("reports a refused connection as a network error", async () => {
    const port = await closedPort()
    const error = await failure({ uri: "sip:alice@example.com", server: `tls://127.0.0.1:${port}` })
    expect(error.message).toMatch(
      new RegExp(`^Network error with tls://127\\.0\\.0\\.1:${port}: .*ECONNREFUSED`),
    )
  })

  it("gives up on a TLS handshake that never finishes", async () => {
    const server = await silentServer()
    cleanups.push(() => server.close())
    const settings = resolveOptions({
      uri: "sip:alice@example.com",
      server: `tls://127.0.0.1:${server.port}`,
    })
    const error = await connectPhone({ ...settings, connectTimeout: 50 }).catch(
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(ConnectError)
    expect(error).toMatchObject({ reason: "network", cause: { name: "TimeoutError" } })
  })

  it("passes a user abort during the handshake through unchanged", async () => {
    const server = await silentServer()
    cleanups.push(() => server.close())
    const signal = AbortSignal.timeout(50)
    const error = await connect({
      uri: "sip:alice@example.com",
      server: `tls://127.0.0.1:${server.port}`,
      signal,
    }).catch((thrown: unknown) => thrown)
    expect(error).toBe(signal.reason)
    expect(error).toMatchObject({ name: "TimeoutError" })
  })

  it("reconnects and registers again when the server closes the connection", async () => {
    const server = await serve(tlsRegistrar())
    const phone = await phoneFor(options(server, "tls"))
    const seen = watch(phone)
    server.sockets[0]?.end()
    await vi.waitFor(() => expect(phone.status).toBe("reconnecting"))
    const lost = `Network error with tls://localhost:${server.port}: the server closed the connection`
    expect(seen).toStrictEqual([{ status: "reconnecting", error: lost }])
    expect(phone.retryAt).toBeGreaterThan(Date.now())
    await expect(phone.ping()).rejects.toThrow(lost)
    await expect(phone.call("bob")).rejects.toThrow(lost)
    await vi.waitFor(() => expect(phone.status).toBe("online"), { timeout: 3000 })
    expect(server.sockets).toHaveLength(2)
    expect(server.registrar.bindings.size).toBe(1)
    expect(phone.error).toBeUndefined()
    expect(phone.retryAt).toBeUndefined()
    expect(await phone.ping()).toMatchObject({ status: 200 })
  })

  it("reconnects after the stream breaks", async () => {
    const server = await serve(tlsRegistrar())
    const phone = await phoneFor(options(server, "tls"))
    server.sockets[0]?.write("OPTIONS sip:a@b SIP/2.0\r\n\r\n")
    await vi.waitFor(() => expect(phone.status).toBe("reconnecting"))
    expect(phone.error).toMatchObject({
      reason: "network",
      message: `Network error with tls://localhost:${server.port}: Missing Content-Length on a stream`,
      cause: { message: "Missing Content-Length on a stream" },
    })
    await vi.waitFor(() => expect(phone.status).toBe("online"), { timeout: 3000 })
  })

  it("keeps trying while the server is gone, and stops when closed", async () => {
    const server = await serve(tlsRegistrar())
    const phone = await phoneFor({
      ...options(server, "tls"),
      signal: new AbortController().signal,
    })
    await server.close()
    await vi.waitFor(() => expect(phone.status).toBe("reconnecting"))
    const first = phone.retryAt ?? 0
    await vi.waitFor(() => expect(phone.retryAt).toBeGreaterThan(first), { timeout: 3000 })
    expect(phone.error?.reason).toBe("network")
    const started = performance.now()
    await phone.close()
    expect(performance.now() - started).toBeLessThan(100)
    expect(phone.status).toBe("offline")
  })

  it("closes cleanly when the connection drops during close", async () => {
    const server = await serve(tlsRegistrar())
    const phone = await phoneFor(options(server, "tls"), { closeTimeout: 2000 })
    const seen = watch(phone)
    server.mute()
    const started = performance.now()
    const closing = phone.close()
    server.sockets[0]?.destroy()
    await closing
    expect(performance.now() - started).toBeLessThan(1000)
    expect(seen).toStrictEqual([{ status: "offline" }])
  })

  it("refuses an invalid ping target", async () => {
    const server = await serve(udpRegistrar())
    const phone = await phoneFor(options(server, "udp"))
    await expect(phone.ping("sip:b@x?Route=evil")).rejects.toThrow(TypeError)
  })

  it("closes once however often it is closed", async () => {
    const server = await serve(udpRegistrar())
    const phone = await phoneFor(options(server, "udp"))
    expect(phone.close()).toBe(phone.close())
    await phone.close()
    expect(expiries(server)[0]).toBe("600")
    expect(expiries(server).filter((expires) => expires === "0")).toHaveLength(2)
  })

  it("unregisters through await using", async () => {
    const server = await serve(udpRegistrar())
    {
      await using phone = await connect(options(server, "udp"))
      expect(phone.status).toBe("online")
    }
    expect(server.registrar.bindings.size).toBe(0)
  })

  it("connects with a connection URL", async () => {
    const server = await serve(udpRegistrar())
    const phone = await connect(`udp://alice:secret@127.0.0.1:${server.port}`)
    cleanups.push(() => phone.close())
    expect(phone.status).toBe("online")
    expect(server.registrar.registers[0]?.uri).toBe("sip:127.0.0.1")
  })

  it("takes the password beside a connection URL", async () => {
    const server = await serve(udpRegistrar())
    const phone = await connect(`udp://alice@127.0.0.1:${server.port}`, { password: "secret" })
    cleanups.push(() => phone.close())
    expect(phone.status).toBe("online")
  })

  it("stops notifying a listener that unsubscribed", async () => {
    const server = await serve(udpRegistrar())
    const phone = await phoneFor(options(server, "udp"))
    const seen: string[] = []
    const off = phone.subscribe(() => seen.push(phone.status))
    off()
    await phone.close()
    expect(seen).toStrictEqual([])
  })

  it("records a real session that replays byte for byte", async () => {
    const server = await serve(udpRegistrar())
    const phone = await phoneFor(options(server, "udp"))
    await phone.ping()
    await phone.close()
    expect(replay(phone.trace ?? "")).toMatchObject({ ok: true })
  })
})
