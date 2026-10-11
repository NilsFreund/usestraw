import { createSocket, type SocketType } from "node:dgram"
import { lookup as dnsLookup, type LookupAddress } from "node:dns"
import { lookup } from "node:dns/promises"
import { once } from "node:events"
import { type AddressInfo, isIP } from "node:net"
import { connect } from "node:tls"
import type { TransportAddress } from "../transport/address"
import { createStreamFramer } from "../transport/stream"
import type { Server } from "./options"

export interface LinkHandlers {
  receive(data: Uint8Array, from: TransportAddress): void
  close(error?: Error): void
}

export interface Link {
  readonly local: TransportAddress
  readonly remote: TransportAddress
  readonly peers: readonly string[]
  start(handlers: LinkHandlers): void
  send(data: Uint8Array, to: TransportAddress): void
  close(): void
}

export interface TlsSettings {
  readonly ca?: string
  readonly rejectUnauthorized?: boolean
}

export interface Peer {
  readonly address: string
  readonly family: number
  readonly port: number
  readonly others?: readonly string[]
}

const KEEPALIVE = 30_000
const NAT_KEEPALIVE = 25_000
const MAX_BACKLOG = 1024 * 1024
const PONG = new Uint8Array([13, 10])
const PING = new Uint8Array([13, 10, 13, 10])
const PONG_WAIT = 10_000

export async function openLink(
  server: Server,
  tls?: TlsSettings,
  signal?: AbortSignal,
): Promise<Link> {
  if (server.transport === "TLS") return openTls(server, tls, signal)
  const found = await lookup(server.host, { all: true, order: "ipv4first" })
  signal?.throwIfAborted()
  const { address, family } = found[0] as LookupAddress
  const others = found.filter((entry) => entry.family === family).map((entry) => entry.address)
  return openUdp({ address, family, port: server.port, others })
}

export async function openUdp(peer: Peer): Promise<Link> {
  const type: SocketType = peer.family === 6 ? "udp6" : "udp4"
  const host = await outboundAddress(type, peer)
  const socket = createSocket(type)
  socket.bind(0)
  await once(socket, "listening")
  let handlers: LinkHandlers | undefined
  let open = true
  let keepalive: ReturnType<typeof setInterval> | undefined
  const remote: TransportAddress = { transport: "UDP", host: peer.address, port: peer.port }
  socket.on("message", (data, info) => {
    handlers?.receive(new Uint8Array(data), {
      transport: "UDP",
      host: info.address,
      port: info.port,
    })
  })
  socket.on("error", () => undefined)
  const send = (data: Uint8Array, to: TransportAddress) => {
    try {
      socket.send(data, to.port, to.host)
    } catch {}
  }
  return {
    local: { transport: "UDP", host, port: socket.address().port },
    remote,
    peers: [...new Set([peer.address, ...(peer.others ?? [])])],
    // RFC 5626 §3.5.1 style CRLF pings keep a NAT binding open between registrations
    start: (next) => {
      handlers = next
      keepalive = setInterval(() => send(PING, remote), NAT_KEEPALIVE)
      keepalive.unref()
    },
    send,
    close: () => {
      clearInterval(keepalive)
      if (open) socket.close()
      open = false
    },
  }
}

// RFC 3261 §18.3: messages on streams are framed by Content-Length; RFC 5626 §3.5.1: answer a ping with CRLF
export async function openTls(
  server: Server,
  options: TlsSettings = {},
  signal?: AbortSignal,
): Promise<Link> {
  const { rejectUnauthorized = true, ca } = options
  const socket = connect({
    host: server.host,
    port: server.port,
    lookup: (host, settings, done) => dnsLookup(host, { ...settings, order: "ipv4first" }, done),
    ...(isIP(server.host) ? {} : { servername: server.host }),
    rejectUnauthorized,
    ...(ca === undefined ? {} : { ca }),
  })
  try {
    await once(socket, "secureConnect", signal ? { signal } : {})
  } catch (error) {
    socket.destroy()
    throw error
  }
  socket.setKeepAlive(true, KEEPALIVE)
  let handlers: LinkHandlers | undefined
  let failure: Error | undefined
  let keepalive: ReturnType<typeof setInterval> | undefined
  let silence: ReturnType<typeof setTimeout> | undefined
  let answers = false
  socket.on("error", (error) => {
    failure = error
  })
  socket.on("close", () => {
    clearInterval(keepalive)
    clearTimeout(silence)
    handlers?.close(failure)
  })
  // RFC 5626 §4.4.1: a server that answered pings and then stays silent is gone
  const ping = () => {
    write(PING)
    if (!answers || silence) return
    silence = setTimeout(() => socket.destroy(new Error("The server stopped answering")), PONG_WAIT)
    silence.unref()
  }
  const framer = createStreamFramer()
  const remote: TransportAddress = {
    transport: "TLS",
    host: String(socket.remoteAddress),
    port: Number(socket.remotePort),
  }
  const local = socket.address() as AddressInfo
  const write = (data: Uint8Array) => {
    if (socket.writableLength > MAX_BACKLOG) socket.destroy(new Error("The server stopped reading"))
    else socket.write(data)
  }
  return {
    local: { transport: "TLS", host: local.address, port: local.port },
    remote,
    peers: [remote.host],
    start: (next) => {
      handlers = next
      keepalive = setInterval(ping, KEEPALIVE)
      keepalive.unref()
      socket.on("data", (chunk: Buffer) => {
        for (const event of framer.push(new Uint8Array(chunk))) {
          if (event.type === "error") {
            socket.destroy(new Error(event.error))
            continue
          }
          answers ||= event.type !== "message"
          clearTimeout(silence)
          silence = undefined
          if (event.type === "message") next.receive(event.data, remote)
          else if (event.type === "ping") write(PONG)
        }
      })
    },
    send: write,
    close: () => {
      socket.destroySoon()
    },
  }
}

async function outboundAddress(type: SocketType, peer: Peer): Promise<string> {
  const probe = createSocket(type)
  try {
    probe.connect(peer.port, peer.address)
    await once(probe, "connect")
    return probe.address().address
  } finally {
    probe.close()
  }
}
