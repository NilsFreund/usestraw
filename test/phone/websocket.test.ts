import { afterEach, describe, expect, it, vi } from "vitest"
import type { Server } from "../../src/phone/options"
import type { Link } from "../../src/phone/platform"
import { invalidHost, openWebSocket, type WebSocketClass } from "../../src/phone/websocket"
import { createRandom } from "../../src/simulation/random"

const server: Server = { transport: "WSS", host: "pbx.example.com", port: 443, path: "/ws" }
const looking =
  "check the address, the path, the certificate and that the server speaks SIP over WebSocket"

// Like a server that never answers the close handshake: close() only records the call
class FakeSocket extends EventTarget {
  static last: FakeSocket | undefined
  binaryType = "blob"
  protocol = ""
  bufferedAmount = 0
  readonly url: string
  readonly protocols: string
  readonly sent: (string | Uint8Array)[] = []
  readonly closes: (number | undefined)[] = []

  constructor(url: string, protocols: string) {
    super()
    this.url = url
    this.protocols = protocols
    FakeSocket.last = this
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data)
  }

  close(code?: number): void {
    this.closes.push(code)
  }

  opened(protocol = "sip"): void {
    this.protocol = protocol
    this.dispatchEvent(new Event("open"))
  }

  closed(code: number, reason = ""): void {
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }))
  }

  message(data: string | ArrayBuffer): void {
    this.dispatchEvent(Object.assign(new Event("message"), { data }))
  }
}

const Socket = FakeSocket as unknown as WebSocketClass
const text = (value: string) => new TextEncoder().encode(value)

function socket(): FakeSocket {
  if (!FakeSocket.last) throw new Error("No socket was opened")
  return FakeSocket.last
}

async function open(protocol = "sip"): Promise<Link> {
  const opening = openWebSocket(server, "a1b2c3.invalid", undefined, Socket)
  socket().opened(protocol)
  return opening
}

async function started() {
  const link = await open()
  const receive = vi.fn()
  const close = vi.fn()
  link.start({ receive, close })
  return { link, receive, close }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("invalidHost", () => {
  it("is a random name under .invalid", () => {
    expect(invalidHost(createRandom(1))).toMatch(/^[a-z0-9]{12}\.invalid$/)
    expect(invalidHost(createRandom(1))).not.toBe(invalidHost(createRandom(2)))
  })
})

describe("openWebSocket", () => {
  it("asks for the sip subprotocol at the server's URL and takes binary as ArrayBuffer", async () => {
    const link = await open()
    expect(socket().url).toBe("wss://pbx.example.com:443/ws")
    expect(socket().protocols).toBe("sip")
    expect(socket().binaryType).toBe("arraybuffer")
    expect(link.local).toEqual({ transport: "WSS", host: "a1b2c3.invalid", port: 0 })
    expect(link.remote).toEqual({ transport: "WSS", host: "pbx.example.com", port: 443 })
    expect(link.peers).toEqual([])
  })

  it("brackets an IPv6 server and defaults the path", async () => {
    const opening = openWebSocket(
      { transport: "WS", host: "::1", port: 8088 },
      "a1b2c3.invalid",
      undefined,
      Socket,
    )
    socket().opened()
    await opening
    expect(socket().url).toBe("ws://[::1]:8088/")
  })

  it("refuses a server that opened without the sip subprotocol", async () => {
    await expect(open("")).rejects.toThrow(
      new Error(
        "The server did not accept the sip WebSocket subprotocol; check that it speaks SIP over WebSocket",
      ),
    )
    expect(socket().closes).toEqual([undefined])
  })

  it("says where to look, without the URL, when the socket closes before it opens", async () => {
    const opening = openWebSocket(server, "a1b2c3.invalid", undefined, Socket)
    socket().closed(1006)
    await expect(opening).rejects.toThrow(new Error(`The WebSocket did not open; ${looking}`))
  })

  it("gives up on an error alone, as Node 22 sends for a failed handshake", async () => {
    const opening = openWebSocket(server, "a1b2c3.invalid", undefined, Socket)
    socket().dispatchEvent(new Event("error"))
    await expect(opening).rejects.toThrow(new Error(`The WebSocket did not open; ${looking}`))
  })

  it("stops at an abort, before or while opening, but not after", async () => {
    const before = new AbortController()
    before.abort(new Error("gone"))
    await expect(openWebSocket(server, "x.invalid", before.signal, Socket)).rejects.toThrow("gone")
    const during = new AbortController()
    const opening = openWebSocket(server, "x.invalid", during.signal, Socket)
    during.abort(new Error("later"))
    await expect(opening).rejects.toThrow("later")
    expect(socket().closes).toEqual([undefined])
    const after = new AbortController()
    const opened = openWebSocket(server, "x.invalid", after.signal, Socket)
    socket().opened()
    await opened
    after.abort()
    expect(socket().closes).toEqual([])
  })

  it("passes on text and binary messages, also those that came before start", async () => {
    const link = await open()
    socket().message("OPTIONS sip:a SIP/2.0\r\n\r\n")
    const receive = vi.fn()
    link.start({ receive, close: vi.fn() })
    socket().message(new Uint8Array([1, 2, 3]).buffer)
    expect(receive.mock.calls).toEqual([
      [text("OPTIONS sip:a SIP/2.0\r\n\r\n"), link.remote],
      [new Uint8Array([1, 2, 3]), link.remote],
    ])
  })

  it("drops a server that sends a message bigger than SIP allows, before reading it", async () => {
    const { link, receive, close } = await started()
    socket().message(new ArrayBuffer(65_535))
    socket().message("x".repeat(65_535))
    expect(receive).toHaveBeenCalledTimes(2)
    socket().message(new ArrayBuffer(65_536))
    expect(socket().closes).toEqual([4002])
    expect(close).toHaveBeenCalledWith(new Error("The server sent a message over 65535 bytes"))
    socket().message("x".repeat(65_536))
    expect(receive).toHaveBeenCalledTimes(2)
    expect(link.remote.transport).toBe("WSS")
  })

  it("sends UTF-8 as text and anything else as binary", async () => {
    const link = await open()
    link.send(text("REGISTER ✓"), link.remote)
    link.send(new Uint8Array([0xff, 0xfe]), link.remote)
    expect(socket().sent).toEqual(["REGISTER ✓", new Uint8Array([0xff, 0xfe])])
  })

  it("closes at once instead of queueing more than a megabyte", async () => {
    const { link, close } = await started()
    socket().bufferedAmount = 1024 * 1024 + 1
    link.send(text("BYE"), link.remote)
    expect(socket().closes).toEqual([4000])
    expect(close).toHaveBeenCalledWith(new Error("The server stopped reading"))
    socket().bufferedAmount = 0
    link.send(text("BYE"), link.remote)
    expect(socket().sent).toEqual([])
  })

  it("reports its own close at once, without waiting for the server, and only once", async () => {
    vi.useFakeTimers()
    const { link, receive, close } = await started()
    link.close()
    expect(socket().closes).toEqual([1000])
    expect(close.mock.calls).toEqual([[undefined]])
    socket().closed(1000)
    socket().message("SIP/2.0 200 OK\r\n\r\n")
    expect(close).toHaveBeenCalledTimes(1)
    expect(receive).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("reports a normal close by the server without an error and anything else with one", async () => {
    const normal = await started()
    socket().closed(1000)
    expect(normal.close.mock.calls).toEqual([[undefined]])
    const other = await started()
    socket().closed(1011, "going away")
    expect(other.close.mock.calls).toEqual([
      [new Error(`The WebSocket closed (1011: going away); ${looking}`)],
    ])
  })

  it("reports a close that came before start, once start runs", async () => {
    const link = await open()
    socket().closed(1006)
    const close = vi.fn()
    link.start({ receive: vi.fn(), close })
    expect(close).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(close).toHaveBeenCalledWith(new Error(`The WebSocket closed (1006); ${looking}`))
  })
})

describe("WebSocket keepalives", () => {
  it("answers a server's CRLF ping and keeps both from the core", async () => {
    const { receive } = await started()
    socket().message("\r\n\r\n")
    socket().message("\r\n")
    expect(socket().sent).toEqual(["\r\n"])
    expect(receive).not.toHaveBeenCalled()
  })

  it("drops a server that ponged twice and then missed a window", async () => {
    vi.useFakeTimers()
    const { close } = await started()
    for (let round = 0; round < 2; round++) {
      await vi.advanceTimersByTimeAsync(30_000)
      socket().message("\r\n")
    }
    await vi.advanceTimersByTimeAsync(30_000)
    expect(socket().sent).toEqual(["\r\n\r\n", "\r\n\r\n", "\r\n\r\n"])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(socket().closes).toEqual([4001])
    expect(close).toHaveBeenCalledWith(new Error("The server stopped answering"))
  })

  it("keeps a server that ponged only once, or not twice in a row", async () => {
    vi.useFakeTimers()
    const { close } = await started()
    await vi.advanceTimersByTimeAsync(30_000)
    socket().message("\r\n")
    await vi.advanceTimersByTimeAsync(40_000)
    await vi.advanceTimersByTimeAsync(20_000)
    socket().message("\r\n")
    await vi.advanceTimersByTimeAsync(40_000)
    expect(close).not.toHaveBeenCalled()
  })

  it("never drops a server that does not pong, or one that sends other data", async () => {
    vi.useFakeTimers()
    const { close } = await started()
    await vi.advanceTimersByTimeAsync(5 * 40_000)
    socket().message("\r\n")
    socket().message("\r\n")
    await vi.advanceTimersByTimeAsync(30_000)
    socket().message("OPTIONS sip:a SIP/2.0\r\n\r\n")
    await vi.advanceTimersByTimeAsync(60_000)
    expect(close).not.toHaveBeenCalled()
  })
})
