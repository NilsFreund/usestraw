import { randomToken } from "../core/ids"
import { formatHost } from "../message/fields/host"
import { MAX_MESSAGE_SIZE } from "../message/limits"
import type { Random } from "../support/random"
import type { TransportAddress } from "../transport/address"
import type { Server } from "./options"
import type { Link, LinkHandlers } from "./platform"

const MAX_BACKLOG = 1024 * 1024
const KEEPALIVE = 30_000
const PONG_WAIT = 10_000
const PING = "\r\n\r\n"
const PONG = "\r\n"
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export type WebSocketClass = new (url: string, protocols: string) => WebSocket

interface Closing {
  readonly code: number
  readonly reason: string
}

// RFC 7118 Appendix B.1: a WebSocket client names itself by a random host nobody can resolve
export function invalidHost(random: Random): string {
  return `${randomToken(random, 12)}.invalid`
}

// RFC 7118 §4: every WebSocket message carries one SIP message, under the "sip" subprotocol
export async function openWebSocket(
  server: Server,
  host: string,
  signal?: AbortSignal,
  Socket: WebSocketClass = WebSocket,
): Promise<Link> {
  signal?.throwIfAborted()
  const scheme = server.transport === "WSS" ? "wss" : "ws"
  const url = `${scheme}://${formatHost(server.host)}:${server.port}${server.path ?? "/"}`
  const socket = new Socket(url, "sip")
  socket.binaryType = "arraybuffer"
  await opened(socket, signal)
  if (socket.protocol !== "sip") {
    socket.close()
    throw new Error(
      "The server did not accept the sip WebSocket subprotocol; check that it speaks SIP over WebSocket",
    )
  }
  return startLink(socket, server, host)
}

function startLink(socket: WebSocket, server: Server, host: string): Link {
  const { transport } = server
  const remote: TransportAddress = { transport, host: server.host, port: server.port }
  const early: Uint8Array[] = []
  let handlers: LinkHandlers | undefined
  let open = true
  let failure: Error | undefined
  let keepalive: ReturnType<typeof setInterval> | undefined
  let silence: ReturnType<typeof setTimeout> | undefined
  let pongs = 0

  // A WebSocket closes only once the server answers, so the link reports a close itself
  function finish(error?: Error): void {
    if (!open) return
    open = false
    failure = error
    clearInterval(keepalive)
    clearTimeout(silence)
    handlers?.close(error)
  }

  function send(data: Uint8Array | string): void {
    if (!open) return
    if (socket.bufferedAmount > MAX_BACKLOG) {
      socket.close(4000)
      finish(new Error("The server stopped reading"))
    } else socket.send(typeof data === "string" ? data : (textOf(data) ?? new Uint8Array(data)))
  }

  // RFC 5626 §4.4.1 over RFC 7118 §6: a server that ponged twice, then misses a window, is gone
  function ping(): void {
    send(PING)
    silence = setTimeout(() => {
      if (pongs > 1) {
        socket.close(4001)
        finish(new Error("The server stopped answering"))
      }
      silence = undefined
      pongs = 0
    }, PONG_WAIT)
  }

  function receive(data: Uint8Array): void {
    const text = textOf(data)
    if (text === PONG && silence) pongs++
    clearTimeout(silence)
    silence = undefined
    if (text === PING) send(PONG)
    else if (text !== PONG) handlers?.receive(data, remote)
  }

  socket.addEventListener("message", ({ data }: { readonly data: string | ArrayBuffer }) => {
    if (!open) return
    // RFC 7118 sets no limit, so a SIP message's own keeps a server from filling the memory
    if ((typeof data === "string" ? data.length : data.byteLength) > MAX_MESSAGE_SIZE) {
      socket.close(4002)
      finish(new Error(`The server sent a message over ${MAX_MESSAGE_SIZE} bytes`))
      return
    }
    const bytes = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data)
    if (handlers) receive(bytes)
    else early.push(bytes)
  })
  socket.addEventListener("close", (event: Closing) => {
    finish(event.code === 1000 ? undefined : closedBy(event))
  })
  return {
    local: { transport, host, port: 0 },
    remote,
    peers: [],
    start: (next) => {
      handlers = next
      if (!open) {
        queueMicrotask(() => next.close(failure))
        return
      }
      keepalive = setInterval(ping, KEEPALIVE)
      for (const data of early.splice(0)) receive(data)
    },
    send,
    close: () => {
      socket.close(1000)
      finish()
    },
  }
}

function opened(socket: WebSocket, signal: AbortSignal | undefined): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const abort = () => {
    reject(signal?.reason)
    socket.close()
  }
  // Node 22 reports a failed handshake only as an error, never with the close that follows it
  const fail = () => reject(new Error(`The WebSocket did not open; ${LOOK}`))
  socket.addEventListener("open", () => resolve(), { once: true })
  socket.addEventListener("error", fail, { once: true })
  socket.addEventListener("close", fail, { once: true })
  signal?.addEventListener("abort", abort, { once: true })
  return promise.finally(() => signal?.removeEventListener("abort", abort))
}

// Browsers hide why a WebSocket failed, so the message says where to look
const LOOK =
  "check the address, the path, the certificate and that the server speaks SIP over WebSocket"

function closedBy(event: Closing): Error {
  const reason = event.reason ? `: ${event.reason}` : ""
  return new Error(`The WebSocket closed (${event.code}${reason}); ${LOOK}`)
}

// RFC 7118 §4.2: SIP that is valid UTF-8 goes as text, anything else as binary
function textOf(data: Uint8Array): string | undefined {
  try {
    return decoder.decode(data)
  } catch {
    return undefined
  }
}
