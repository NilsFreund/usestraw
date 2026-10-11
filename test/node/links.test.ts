import { createSocket, Socket } from "node:dgram"
import dns from "node:dns"
import { isIP } from "node:net"
import { networkInterfaces } from "node:os"
import { describe, expect, it, vi } from "vitest"
import type { TransportAddress } from "../../src"
import { type LinkHandlers, openLink, openTls, openUdp } from "../../src/node/links"
import { certificate, localhost, silentServer, tlsRegistrar } from "./servers"

function recorder() {
  const log: string[] = []
  const handlers: LinkHandlers = {
    receive: (data) => log.push(`receive ${new TextDecoder().decode(data).split("\r\n", 1)[0]}`),
    close: (error) => log.push(error === undefined ? "close" : `close ${error.message}`),
  }
  return { log, handlers }
}

const tls = (port: number, host = "localhost") => ({ transport: "TLS", host, port }) as const
const udpHandles = () =>
  process.getActiveResourcesInfo().filter((resource) => resource === "UDPWrap").length
const ipv6 = Object.values(networkInterfaces())
  .flat()
  .some((entry) => entry?.internal && entry.family === "IPv6")

describe("openUdp", () => {
  it("survives send errors and failed lookups and keeps sending", async () => {
    const lookup = dns.lookup
    vi.spyOn(dns, "lookup").mockImplementation(((
      host: string,
      family: number,
      callback: (error: Error | null, address?: string, family?: number) => void,
    ) =>
      isIP(host)
        ? lookup(host, family, callback)
        : callback(
            Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }),
          )) as typeof dns.lookup)
    const sink = createSocket("udp4")
    const received: number[] = []
    sink.on("message", (data) => received.push(data.length))
    await new Promise<void>((resolve) => sink.bind(0, "127.0.0.1", resolve))
    const to = { transport: "UDP", host: "127.0.0.1", port: sink.address().port } as const
    const link = await openUdp({ address: "127.0.0.1", family: 4, port: to.port })
    const { log, handlers } = recorder()
    link.start(handlers)
    link.send(new Uint8Array(70_000), to)
    link.send(new Uint8Array(1), { ...to, host: "registrar.example" })
    link.send(new Uint8Array(2), { ...to, port: 0 })
    link.send(new Uint8Array(3), to)
    await vi.waitFor(() => expect(received).toStrictEqual([3]))
    expect(log).toStrictEqual([])
    link.close()
    link.close()
    sink.close()
    vi.restoreAllMocks()
  })

  it("pings the server every 25 s to keep a NAT binding open, and stops when closed", async () => {
    const sink = createSocket("udp4")
    const received: string[] = []
    sink.on("message", (data) => received.push(data.toString()))
    await new Promise<void>((resolve) => sink.bind(0, "127.0.0.1", resolve))
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    try {
      const link = await openUdp({ address: "127.0.0.1", family: 4, port: sink.address().port })
      link.start(recorder().handlers)
      vi.advanceTimersByTime(25_000)
      await vi.waitFor(() => expect(received).toStrictEqual(["\r\n\r\n"]))
      link.close()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      sink.close()
    }
  })

  it("knows every address of the server, once each", async () => {
    const link = await openUdp({
      address: "127.0.0.1",
      family: 4,
      port: 5060,
      others: ["127.0.0.1", "127.0.0.2"],
    })
    expect(link.peers).toStrictEqual(["127.0.0.1", "127.0.0.2"])
    link.close()
  })

  it("reports the outbound address and where each datagram came from", async () => {
    const link = await openUdp({ address: "127.0.0.2", family: 4, port: 5060 })
    const other = createSocket("udp4")
    await new Promise<void>((resolve) => other.bind(0, "127.0.0.1", resolve))
    const seen: TransportAddress[] = []
    link.start({ receive: (_, from) => seen.push(from), close: () => undefined })
    other.send("x", link.local.port, "127.0.0.1")
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(link.local.host).toBe("127.0.0.1")
    expect(link.remote).toStrictEqual({ transport: "UDP", host: "127.0.0.2", port: 5060 })
    expect(seen).toStrictEqual([
      { transport: "UDP", host: "127.0.0.1", port: other.address().port },
    ])
    link.close()
    other.close()
  })

  it("closes its probe and its socket", async () => {
    await vi.waitFor(() => expect(udpHandles()).toBe(0))
    const link = await openUdp({ address: "127.0.0.1", family: 4, port: 5060 })
    await vi.waitFor(() => expect(udpHandles()).toBe(1))
    link.close()
    await vi.waitFor(() => expect(udpHandles()).toBe(0))
  })

  it.skipIf(!ipv6)("binds a UDP6 socket and finds the outbound address", async () => {
    const link = await openUdp({ address: "::1", family: 6, port: 5060 })
    expect(link.local).toMatchObject({ transport: "UDP", host: "::1" })
    expect(link.remote).toStrictEqual({ transport: "UDP", host: "::1", port: 5060 })
    link.close()
  })

  it("binds the port it is given, and frees the socket when that port is taken", async () => {
    await vi.waitFor(() => expect(udpHandles()).toBe(0))
    const taken = createSocket("udp4")
    await new Promise<void>((resolve) => taken.bind(0, resolve))
    const port = taken.address().port
    const peer = { address: "127.0.0.1", family: 4, port: 5060 }
    await expect(openUdp(peer, port)).rejects.toMatchObject({ code: "EADDRINUSE" })
    await vi.waitFor(() => expect(udpHandles()).toBe(1))
    taken.close()
    const link = await openLink({ transport: "UDP", host: "127.0.0.1", port: 5060 }, { port })
    expect(link.local).toStrictEqual({ transport: "UDP", host: "127.0.0.1", port })
    link.close()
  })

  it("binds its port exclusively, so cluster workers never share one", async () => {
    const bind = vi.spyOn(Socket.prototype, "bind")
    const link = await openUdp({ address: "127.0.0.1", family: 4, port: 5060 })
    expect(bind).toHaveBeenCalledWith({ port: 0, exclusive: true })
    bind.mockRestore()
    link.close()
  })

  it("fails when the address family does not match", async () => {
    await expect(openUdp({ address: "::1", family: 4, port: 5060 })).rejects.toThrow()
  })
})

describe("openLink", () => {
  it("resolves the host preferring IPv4 and opens UDP", async () => {
    const link = await openLink({ transport: "UDP", host: "localhost", port: 5060 })
    expect(link.remote).toStrictEqual({ transport: "UDP", host: "127.0.0.1", port: 5060 })
    expect(link.peers).toStrictEqual(["127.0.0.1"])
    link.close()
  })

  it("stops after the lookup when aborted", async () => {
    const server = { transport: "UDP", host: "localhost", port: 5060 } as const
    await expect(openLink(server, {}, AbortSignal.abort())).rejects.toThrow(
      "This operation was aborted",
    )
  })

  it("prefers IPv4 for TLS where the server listens on both", async () => {
    const server = await tlsRegistrar({}, { host: "::" })
    const link = await openLink(tls(server.port), { tls: { ca: certificate } })
    expect(link.local.host).toBe("127.0.0.1")
    link.close()
    await server.close()
  })

  it("opens TLS by hostname with SNI", async () => {
    const server = await tlsRegistrar()
    const link = await openLink(tls(server.port), { tls: { ca: certificate } })
    const { address } = await localhost(server.port)
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1))
    expect(server.sockets[0]?.servername).toBe("localhost")
    expect(link.local).toStrictEqual({
      transport: "TLS",
      host: server.sockets[0]?.remoteAddress,
      port: server.sockets[0]?.remotePort,
    })
    expect(link.remote).toStrictEqual({ transport: "TLS", host: address, port: server.port })
    expect(link.peers).toStrictEqual([address])
    link.close()
    await server.close()
  })
})

describe("openTls", () => {
  it("refuses a server whose certificate it cannot verify", async () => {
    const server = await tlsRegistrar()
    await expect(openTls(tls(server.port))).rejects.toThrow(/certificate/)
    await server.close()
  })

  it("connects to an IP address without SNI when verification is off", async () => {
    const server = await tlsRegistrar()
    const { address } = await localhost(server.port)
    const link = await openTls(tls(server.port, address), { rejectUnauthorized: false })
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1))
    expect(server.sockets[0]?.servername).toBe(false)
    expect(link.remote.host).toBe(address)
    link.close()
    await server.close()
  })

  it("gives up on a handshake that never finishes when aborted", async () => {
    const server = await silentServer()
    const started = performance.now()
    await expect(
      openTls(tls(server.port, "127.0.0.1"), {}, AbortSignal.timeout(50)),
    ).rejects.toThrow("The operation was aborted")
    expect(performance.now() - started).toBeLessThan(1000)
    await server.close()
  })

  it("pings the server every 30 s so idle connections stay up, and stops when closed", async () => {
    const server = await tlsRegistrar()
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    try {
      const link = await openTls(tls(server.port), { ca: certificate })
      link.start(recorder().handlers)
      await vi.waitFor(() => expect(server.sockets).toHaveLength(1))
      const [socket] = server.sockets
      const ping = new Promise<string>((resolve) =>
        socket?.once("data", (chunk: Buffer) => resolve(chunk.toString())),
      )
      vi.advanceTimersByTime(30_000)
      expect(await ping).toBe("\r\n\r\n")
      link.close()
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0))
    } finally {
      vi.useRealTimers()
      await server.close()
    }
  })

  it("keeps a connection whose server answers pings, and closes it once it stops", async () => {
    const server = await tlsRegistrar()
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] })
    try {
      const link = await openTls(tls(server.port), { ca: certificate })
      const { log, handlers } = recorder()
      link.start(handlers)
      await vi.waitFor(() => expect(server.sockets).toHaveLength(1))
      const [socket] = server.sockets
      const ping = async () => {
        const pinged = new Promise((resolve) => socket?.once("data", resolve))
        vi.advanceTimersByTime(30_000)
        await pinged
      }
      const answer = async (user: string) => {
        socket?.write(`\r\nOPTIONS sip:${user}@b SIP/2.0\r\nContent-Length: 0\r\n\r\n`)
        await vi.waitFor(() => expect(log.at(-1)).toBe(`receive OPTIONS sip:${user}@b SIP/2.0`))
      }
      await ping()
      await answer("first")
      await ping()
      await answer("second")
      vi.advanceTimersByTime(10_000)
      await answer("third")
      await ping()
      vi.advanceTimersByTime(9_999)
      expect(log).toHaveLength(3)
      vi.advanceTimersByTime(1)
      await vi.waitFor(() => expect(log.at(-1)).toBe("close The server stopped answering"))
    } finally {
      vi.useRealTimers()
      await server.close()
    }
  })

  it("answers a ping with a pong and closes on a framing error", async () => {
    const server = await tlsRegistrar()
    const link = await openTls(tls(server.port), { ca: certificate })
    const { log, handlers } = recorder()
    link.start(handlers)
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1))
    const [socket] = server.sockets
    const pong = new Promise<string>((resolve) =>
      socket?.once("data", (chunk: Buffer) => resolve(chunk.toString())),
    )
    socket?.write("\r\n\r\n")
    expect(await pong).toBe("\r\n")
    socket?.write("\r\n")
    socket?.write("OPTIONS sip:a@b SIP/2.0\r\nContent-Length: 0\r\n\r\n")
    socket?.write("OPTIONS sip:a@b SIP/2.0\r\nCall-ID: c\r\n\r\n")
    await vi.waitFor(() => expect(log).toHaveLength(2))
    expect(log).toStrictEqual([
      "receive OPTIONS sip:a@b SIP/2.0",
      "close Missing Content-Length on a stream",
    ])
    await server.close()
  })

  it("closes when the server stops reading", async () => {
    const server = await tlsRegistrar()
    const link = await openTls(tls(server.port), { ca: certificate })
    const { log, handlers } = recorder()
    link.start(handlers)
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1))
    server.sockets[0]?.pause()
    const chunk = new Uint8Array(64 * 1024)
    for (let round = 0; round < 400 && log.length === 0; round++) {
      link.send(chunk, link.remote)
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(log).toStrictEqual(["close The server stopped reading"])
    await server.close()
  })

  it("closes instead of queueing a pong behind a stuck backlog", async () => {
    const server = await tlsRegistrar()
    const link = await openTls(tls(server.port), { ca: certificate })
    const { log, handlers } = recorder()
    link.start(handlers)
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1))
    const [socket] = server.sockets
    socket?.pause()
    link.send(new Uint8Array(16 * 1024 * 1024), link.remote)
    socket?.write("\r\n\r\n")
    await vi.waitFor(() => expect(log).toStrictEqual(["close The server stopped reading"]))
    await server.close()
  })

  it("reports a connection the server ends", async () => {
    const server = await tlsRegistrar()
    const link = await openTls(tls(server.port), { ca: certificate })
    const { log, handlers } = recorder()
    link.start(handlers)
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1))
    server.sockets[0]?.end()
    await vi.waitFor(() => expect(log).toStrictEqual(["close"]))
    await server.close()
  })

  it("closes without waiting for a server that keeps its side open", async () => {
    const server = await tlsRegistrar({}, { allowHalfOpen: true })
    const link = await openTls(tls(server.port), { ca: certificate })
    const { log, handlers } = recorder()
    link.start(handlers)
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1))
    link.close()
    link.close()
    await vi.waitFor(() => expect(log).toStrictEqual(["close"]))
    await server.close()
  })

  it("flushes what it sent before it closes", async () => {
    const server = await tlsRegistrar()
    const link = await openTls(tls(server.port), { ca: certificate })
    link.start(recorder().handlers)
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1))
    for (let round = 0; round < 15; round++) link.send(new Uint8Array(64 * 1024), link.remote)
    link.close()
    await vi.waitFor(() => expect(server.bytes).toBe(15 * 64 * 1024))
    await server.close()
  })
})
