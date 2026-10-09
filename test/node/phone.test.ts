import { afterEach, describe, expect, it } from "vitest"
import { getHeader } from "../../src"
import { type Phone, type RegisterOptions, RegistrationError, register } from "../../src/node"
import { resolveOptions } from "../../src/node/options"
import { connectPhone } from "../../src/node/phone"
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

function options(server: TestServer, transport: "udp" | "tls"): RegisterOptions {
  return {
    uri: "sip:alice@example.com",
    password: "secret",
    server: `${transport}://${transport === "tls" ? "localhost" : "127.0.0.1"}:${server.port}`,
    ...(transport === "tls" ? { tls: { ca: certificate } } : {}),
  }
}

async function phoneFor(settings: RegisterOptions): Promise<Phone> {
  const phone = await register(settings)
  cleanups.push(() => phone.close())
  return phone
}

async function failure(settings: RegisterOptions): Promise<RegistrationError> {
  const error = await register(settings).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  if (!(error instanceof RegistrationError)) throw new Error(`Expected a RegistrationError`)
  return error
}

async function collect<T>(changes: AsyncIterable<T>): Promise<T[]> {
  const seen: T[] = []
  for await (const change of changes) seen.push(change)
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

describe.each(["udp", "tls"] as const)("register over %s", (transport) => {
  const start = (settings = {}) =>
    serve(transport === "tls" ? tlsRegistrar(settings) : udpRegistrar(settings))

  it("resolves once registered and unregisters on close", async () => {
    const server = await start({ algorithm: "SHA-256" })
    const phone = await phoneFor({ ...options(server, transport), expires: 120 })
    const changes = collect(phone.changes)
    expect(phone.state).toBe("registered")
    expect(server.registrar.bindings.size).toBe(1)
    const started = performance.now()
    await phone.close()
    expect(performance.now() - started).toBeLessThan(1000)
    expect(phone.state).toBe("closed")
    expect(server.registrar.bindings.size).toBe(0)
    expect(expiries(server)).toStrictEqual(["120", "120", "0", "0"])
    expect(await changes).toStrictEqual([{ state: "closed" }])
  })

  it("registers its real local address", async () => {
    const server = await start()
    await phoneFor(options(server, transport))
    const [request] = server.registrar.registers
    expect(request?.via[0]?.transport).toBe(transport.toUpperCase())
    expect(["127.0.0.1", "[::1]"]).toContain(request?.via[0]?.host)
    expect(request?.via[0]?.port).toBeGreaterThan(0)
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
    expect(error.failure).toStrictEqual({ reason: "no-credentials" })
    expect(error.message).toMatch(/ asks for a password, but none was given$/)
  })

  it("refuses to register with a wrong password", async () => {
    const server = await start()
    const error = await failure({ ...options(server, transport), password: "wrong" })
    expect(error.failure).toStrictEqual({ reason: "unauthorized", status: 401 })
    expect(error.message).toContain('refused the password for "alice" with 401')
  })

  it("refuses to register when the registrar rejects the first attempt", async () => {
    const server = await start({ script: [503], retryAfter: 60 })
    const error = await failure(options(server, transport))
    expect(error.failure).toStrictEqual({ reason: "rejected", status: 503, phrase: "Scripted" })
  })

  it("refuses invalid options before it connects", async () => {
    const server = await start()
    await expect(register({ ...options(server, transport), password: "a\r\nb" })).rejects.toThrow(
      TypeError,
    )
    await expect(register({ ...options(server, transport), expires: 0 })).rejects.toThrow(
      "Invalid expires 0",
    )
    await pause(50)
    expect(server.received).toBe(0)
    expect(server.sockets).toHaveLength(0)
  })

  it("gives up waiting for the unregister after the close timeout", async () => {
    const server = await start()
    const phone = await phoneFor({ ...options(server, transport), closeTimeout: 50 })
    server.mute()
    const started = performance.now()
    await phone.close()
    expect(performance.now() - started).toBeGreaterThanOrEqual(45)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(phone.state).toBe("closed")
  })

  it("rejects pings after close and pings still waiting at close", async () => {
    const server = await start()
    const phone = await phoneFor({ ...options(server, transport), closeTimeout: 50 })
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
    await expect(register({ ...options(server, transport), signal })).rejects.toMatchObject({
      name: "TimeoutError",
    })
    const received = server.received
    await pause(600)
    expect(server.received).toBe(received)
  })

  it("keeps running when the signal aborts after the registration", async () => {
    const server = await start()
    const controller = new AbortController()
    const phone = await phoneFor({ ...options(server, transport), signal: controller.signal })
    controller.abort()
    expect(phone.state).toBe("registered")
    expect((await phone.ping()).status).toBe(200)
  })
})

describe("register", () => {
  it("derives a UDP server from a sip uri", async () => {
    const server = await serve(udpRegistrar())
    const phone = await phoneFor({ uri: `sip:alice@127.0.0.1:${server.port}`, password: "secret" })
    expect(phone.state).toBe("registered")
  })

  it("derives a TLS server from a sips uri", async () => {
    const server = await serve(tlsRegistrar())
    const phone = await phoneFor({
      uri: `sips:alice@localhost:${server.port}`,
      password: "secret",
      tls: { ca: certificate },
    })
    expect(phone.state).toBe("registered")
    expect(server.registrar.registers[0]?.uri).toBe(`sips:localhost:${server.port}`)
  })

  it("uses the username instead of the user part of the uri", async () => {
    const server = await serve(udpRegistrar({ users: { a1: "secret" } }))
    const phone = await phoneFor({ ...options(server, "udp"), username: "a1" })
    expect(phone.state).toBe("registered")
  })

  it("refuses invalid options", async () => {
    await expect(register({ uri: "alice" })).rejects.toThrow('Invalid uri "alice"')
    await expect(register({ uri: "sip:alice@example.com", server: "x" })).rejects.toThrow(
      'Invalid server "x"',
    )
  })

  it("does not start when the signal has already aborted", async () => {
    const server = await serve(udpRegistrar())
    const signal = AbortSignal.abort()
    await expect(register({ ...options(server, "udp"), signal })).rejects.toBe(signal.reason)
    await pause(50)
    expect(server.received).toBe(0)
  })

  it("reports an untrusted certificate as a network error with a hint", async () => {
    const server = await serve(tlsRegistrar())
    const error = await failure({
      uri: "sip:alice@example.com",
      server: `tls://localhost:${server.port}`,
    })
    expect(error.failure).toStrictEqual({ reason: "network" })
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
    expect(error).toBeInstanceOf(RegistrationError)
    expect(error).toMatchObject({
      failure: { reason: "network" },
      cause: { name: "TimeoutError" },
    })
  })

  it("passes a user abort during the handshake through unchanged", async () => {
    const server = await silentServer()
    cleanups.push(() => server.close())
    const signal = AbortSignal.timeout(50)
    const error = await register({
      uri: "sip:alice@example.com",
      server: `tls://127.0.0.1:${server.port}`,
      signal,
    }).catch((thrown: unknown) => thrown)
    expect(error).toBe(signal.reason)
    expect(error).toMatchObject({ name: "TimeoutError" })
  })

  it("closes with the reason when the server closes the connection", async () => {
    const server = await serve(tlsRegistrar())
    const phone = await phoneFor(options(server, "tls"))
    const changes = collect(phone.changes)
    server.sockets[0]?.end()
    expect(await changes).toStrictEqual([
      {
        state: "closed",
        error: new RegistrationError(
          { reason: "network" },
          { label: `tls://localhost:${server.port}`, username: "alice" },
        ),
      },
    ])
    expect(phone.state).toBe("closed")
    await expect(phone.ping()).rejects.toThrow("The phone is closed")
    await phone.close()
  })

  it("closes with the cause when the stream breaks", async () => {
    const server = await serve(tlsRegistrar())
    const phone = await phoneFor(options(server, "tls"))
    const changes = collect(phone.changes)
    server.sockets[0]?.write("OPTIONS sip:a@b SIP/2.0\r\n\r\n")
    const [change] = await changes
    expect(change).toMatchObject({
      state: "closed",
      error: {
        message: `Network error with tls://localhost:${server.port}: Missing Content-Length on a stream`,
        cause: { message: "Missing Content-Length on a stream" },
      },
    })
  })

  it("closes cleanly when the connection drops during close", async () => {
    const server = await serve(tlsRegistrar())
    const phone = await phoneFor({ ...options(server, "tls"), closeTimeout: 2000 })
    const changes = collect(phone.changes)
    server.mute()
    const started = performance.now()
    const closing = phone.close()
    server.sockets[0]?.destroy()
    await closing
    expect(performance.now() - started).toBeLessThan(1000)
    expect(await changes).toStrictEqual([{ state: "closed" }])
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
    expect(expiries(server).filter((expires) => expires === "0")).toHaveLength(2)
  })

  it("unregisters through await using", async () => {
    const server = await serve(udpRegistrar())
    {
      await using phone = await register(options(server, "udp"))
      expect(phone.state).toBe("registered")
    }
    expect(server.registrar.bindings.size).toBe(0)
  })

  it("exposes its changes only as an async iterable", async () => {
    const server = await serve(udpRegistrar())
    const phone = await phoneFor(options(server, "udp"))
    expect(Object.keys(phone.changes)).toStrictEqual([])
    expect(Object.getOwnPropertySymbols(phone.changes)).toStrictEqual([Symbol.asyncIterator])
  })
})
