import { createSocket } from "node:dgram"
import { lookup } from "node:dns/promises"
import { readFileSync } from "node:fs"
import { createServer as createNetServer, type Socket } from "node:net"
import { createServer, type TLSSocket } from "node:tls"
import type { Peer } from "../../src/node/links"
import { createRandom } from "../../src/simulation/random"
import { createStreamFramer } from "../../src/transport/stream"
import { type Registrar, type RegistrarOptions, registrar } from "../registrar"

export const certificate: string = readFileSync(
  new URL("../fixtures/tls/localhost.crt", import.meta.url),
  "utf8",
)
const key = readFileSync(new URL("../fixtures/tls/localhost.key", import.meta.url), "utf8")

export interface TestServer {
  readonly port: number
  readonly registrar: Registrar
  readonly sockets: TLSSocket[]
  readonly received: number
  readonly bytes: number
  mute(): void
  close(): Promise<void>
}

export async function udpRegistrar(options: RegistrarOptions = {}): Promise<TestServer> {
  const server = registrar(options)(createRandom(9))
  const socket = createSocket("udp4")
  let received = 0
  let bytes = 0
  let muted = false
  socket.on("message", (data, info) => {
    received++
    bytes += data.length
    if (muted) return
    const from = { transport: "UDP", host: info.address, port: info.port } as const
    for (const output of server.handle(
      { type: "receive", data: new Uint8Array(data), from },
      performance.now(),
    )) {
      if (output.type === "send") socket.send(output.data, output.to.port, output.to.host)
    }
  })
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve))
  let closed = false
  return {
    port: socket.address().port,
    registrar: server,
    sockets: [],
    get received() {
      return received
    },
    get bytes() {
      return bytes
    },
    mute: () => {
      muted = true
    },
    close: () => {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise((resolve) => socket.close(() => resolve()))
    },
  }
}

export async function tlsRegistrar(
  options: RegistrarOptions = {},
  {
    allowHalfOpen = false,
    host = "localhost",
  }: { readonly allowHalfOpen?: boolean; readonly host?: string } = {},
): Promise<TestServer> {
  const server = registrar(options)(createRandom(9))
  const sockets: TLSSocket[] = []
  let received = 0
  let bytes = 0
  let muted = false
  const tls = createServer({ key, cert: certificate, allowHalfOpen }, (socket) => {
    sockets.push(socket)
    const framer = createStreamFramer()
    const from = {
      transport: "TLS",
      host: socket.remoteAddress ?? "127.0.0.1",
      port: socket.remotePort ?? 0,
    } as const
    socket.on("error", () => {})
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      for (const event of framer.push(new Uint8Array(chunk))) {
        if (event.type !== "message") continue
        received++
        if (muted) continue
        for (const output of server.handle(
          { type: "receive", data: event.data, from },
          performance.now(),
        )) {
          if (output.type === "send") socket.write(output.data)
        }
      }
    })
  })
  await new Promise<void>((resolve) => tls.listen(0, host, resolve))
  const address = tls.address()
  return {
    port: typeof address === "object" && address ? address.port : 0,
    registrar: server,
    sockets,
    get received() {
      return received
    },
    get bytes() {
      return bytes
    },
    mute: () => {
      muted = true
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        tls.close(() => resolve())
      }),
  }
}

export async function localhost(port: number): Promise<Peer> {
  const { address, family } = await lookup("localhost")
  return { address, family, port }
}

export async function silentServer(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets: Socket[] = []
  const server = createNetServer((socket) => sockets.push(socket))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  return {
    port: typeof address === "object" && address ? address.port : 0,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

export async function closedPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  return typeof address === "object" && address ? address.port : 0
}
