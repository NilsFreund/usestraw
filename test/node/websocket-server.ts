import { createHash } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo, Socket } from "node:net"

export interface WebSocketPeer {
  readonly remotePort: number
  send(data: Uint8Array | string): void
  close(code?: number): void
  destroy(): void
}

export interface WebSocketServerOptions {
  readonly path?: string
  // The subprotocol the server picks; null leaves the header out
  readonly protocol?: string | null
  readonly onMessage: (peer: WebSocketPeer, data: Uint8Array, text: boolean) => void
  readonly onConnection?: (peer: WebSocketPeer) => void
  // Like a wedged server, never answer the close handshake
  readonly ignoreClose?: boolean
}

export interface WebSocketServer {
  readonly port: number
  readonly peers: WebSocketPeer[]
  readonly offered: (string | undefined)[]
  close(): Promise<void>
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// RFC 6455 from the server side, just enough for SIP: unfragmented frames, ping, close
export async function startWebSocketServer(
  options: WebSocketServerOptions,
): Promise<WebSocketServer> {
  const { path = "/", protocol = "sip", onMessage, onConnection, ignoreClose = false } = options
  const peers: WebSocketPeer[] = []
  const offered: (string | undefined)[] = []
  const sockets = new Set<Socket>()
  const http = createServer((_, response) => response.writeHead(426).end())
  http.on("upgrade", (request: IncomingMessage, socket: Socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    offered.push(request.headers["sec-websocket-protocol"])
    if (request.url !== path) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
      return
    }
    const key = request.headers["sec-websocket-key"] ?? ""
    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64")
    const chosen = protocol === null ? "" : `Sec-WebSocket-Protocol: ${protocol}\r\n`
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${chosen}\r\n`,
    )
    const peer: WebSocketPeer = {
      remotePort: Number(socket.remotePort),
      send: (data) => {
        socket.write(frame(typeof data === "string" ? 1 : 2, Buffer.from(data)))
      },
      close: (code = 1000) => {
        const body = Buffer.alloc(2)
        body.writeUInt16BE(code)
        socket.end(frame(8, body))
      },
      destroy: () => socket.destroy(),
    }
    peers.push(peer)
    onConnection?.(peer)
    let pending = Buffer.alloc(0)
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        const parsed = unframe(pending)
        if (!parsed) return
        pending = pending.subarray(parsed.size)
        if (parsed.opcode === 8) {
          if (!ignoreClose) peer.close()
        } else if (parsed.opcode === 9) socket.write(frame(10, parsed.payload))
        else if (parsed.opcode === 1 || parsed.opcode === 2) {
          onMessage(peer, new Uint8Array(parsed.payload), parsed.opcode === 1)
        }
      }
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  return {
    port: (http.address() as AddressInfo).port,
    peers,
    offered,
    close: () => {
      for (const socket of sockets) socket.destroy()
      return new Promise((resolve) => http.close(() => resolve()))
    },
  }
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload])
  if (length < 65_536) {
    return Buffer.concat([Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]), payload])
  }
  const head = Buffer.alloc(10)
  head[0] = 0x80 | opcode
  head[1] = 127
  head.writeBigUInt64BE(BigInt(length), 2)
  return Buffer.concat([head, payload])
}

function unframe(
  data: Buffer,
): { readonly opcode: number; readonly payload: Buffer; readonly size: number } | undefined {
  if (data.length < 2) return undefined
  const opcode = (data[0] as number) & 0x0f
  let length = (data[1] as number) & 0x7f
  let offset = 2
  if (length === 126) {
    if (data.length < 4) return undefined
    length = data.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (data.length < 10) return undefined
    length = Number(data.readBigUInt64BE(2))
    offset = 10
  }
  const masked = ((data[1] as number) & 0x80) !== 0
  const mask = masked ? data.subarray(offset, offset + 4) : undefined
  if (masked) offset += 4
  if (data.length < offset + length) return undefined
  const payload = Buffer.from(data.subarray(offset, offset + length))
  if (mask)
    for (let i = 0; i < payload.length; i++)
      payload[i] = (payload[i] as number) ^ (mask[i % 4] as number)
  return { opcode, payload, size: offset + length }
}
