import { createSocket, type SocketType } from "node:dgram"
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
}

const KEEPALIVE = 30_000
const MAX_BACKLOG = 1024 * 1024
const PONG = new Uint8Array([13, 10])

export async function openLink(
  server: Server,
  tls?: TlsSettings,
  signal?: AbortSignal,
): Promise<Link> {
  if (server.transport === "TLS") return openTls(server, tls, signal)
  const { address, family } = await lookup(server.host, { order: "ipv4first" })
  signal?.throwIfAborted()
  return openUdp({ address, family, port: server.port })
}

export async function openUdp(peer: Peer): Promise<Link> {
  const type: SocketType = peer.family === 6 ? "udp6" : "udp4"
  const host = await outboundAddress(type, peer)
  const socket = createSocket(type)
  socket.bind(0)
  await once(socket, "listening")
  let handlers: LinkHandlers | undefined
  let open = true
  socket.on("message", (data, info) => {
    handlers?.receive(new Uint8Array(data), {
      transport: "UDP",
      host: info.address,
      port: info.port,
    })
  })
  socket.on("error", () => undefined)
  return {
    local: { transport: "UDP", host, port: socket.address().port },
    remote: { transport: "UDP", host: peer.address, port: peer.port },
    start: (next) => {
      handlers = next
    },
    send: (data, to) => {
      socket.send(data, to.port, to.host)
    },
    close: () => {
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
  socket.on("error", (error) => {
    failure = error
  })
  socket.on("close", () => handlers?.close(failure))
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
    start: (next) => {
      handlers = next
      socket.on("data", (chunk: Buffer) => {
        for (const event of framer.push(new Uint8Array(chunk))) {
          if (event.type === "message") next.receive(event.data, remote)
          else if (event.type === "ping") write(PONG)
          else if (event.type === "error") socket.destroy(new Error(event.error))
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
