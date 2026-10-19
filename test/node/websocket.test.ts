import { afterEach, describe, expect, it, vi } from "vitest"
import { ConnectError, connect, type Phone } from "../../src"
import { getHeader, type SipRequest } from "../../src/core"
import { nodePlatform } from "../../src/node/connect"
import { resolveOptions } from "../../src/phone/options"
import { openWebSocket } from "../../src/phone/websocket"
import { type WebSocketRegistrar, wsRegistrar } from "./servers"
import { startWebSocketServer } from "./websocket-server"

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function serve(options?: Parameters<typeof wsRegistrar>[1]): Promise<WebSocketRegistrar> {
  const server = await wsRegistrar({}, options)
  cleanups.push(() => server.close())
  return server
}

async function phoneAt(url: string): Promise<Phone> {
  const phone = await connect(url)
  cleanups.push(() => phone.close())
  return phone
}

function lastRegister(server: WebSocketRegistrar): SipRequest {
  const register = server.registrar.registers.at(-1)
  if (!register) throw new Error("No REGISTER arrived")
  return register
}

async function failure(url: string): Promise<ConnectError> {
  const error = await connect(url).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  if (!(error instanceof ConnectError)) throw new Error("Expected a ConnectError")
  return error
}

describe("connect over WebSocket", () => {
  it("registers with an RFC 7118 Via and Contact and the RFC 5626 instance", async () => {
    const server = await serve()
    const phone = await phoneAt(`ws://alice:secret@127.0.0.1:${server.port}/ws`)
    expect(phone.status).toBe("online")
    const register = lastRegister(server)
    const [via] = register.via
    expect(via?.transport).toBe("WS")
    expect(via?.port).toBeUndefined()
    expect(via?.host).toMatch(/^[a-z0-9]{12}\.invalid$/)
    const [contact] = register.contact === "*" ? [] : register.contact
    expect(contact?.uri).toBe(`sip:alice@${via?.host};transport=ws`)
    expect(contact?.params.get("reg-id")).toBe("1")
    expect(contact?.params.get("+sip.instance")).toMatch(
      /^"<urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}>"$/,
    )
    expect(getHeader(register, "Supported")).toBe("path, outbound")
    expect(server.offered).toEqual(["sip"])
    expect(new Set(server.frames)).toEqual(new Set(["text"]))
  })

  it("unregisters when it closes", async () => {
    const server = await serve()
    const phone = await connect(`ws://alice:secret@127.0.0.1:${server.port}/ws`)
    await phone.close()
    expect(phone.status).toBe("closed")
    expect(getHeader(lastRegister(server), "Expires")).toBe("0")
    expect(server.registrar.bindings.size).toBe(0)
  })

  it("comes back with the same Contact after the server drops the connection", async () => {
    const server = await serve()
    const phone = await phoneAt(`ws://alice:secret@127.0.0.1:${server.port}/ws`)
    const before = lastRegister(server).contact
    server.peers[0]?.destroy()
    await expect.poll(() => server.peers.length, { timeout: 5000 }).toBe(2)
    await expect.poll(() => phone.status, { timeout: 5000 }).toBe("online")
    const after = lastRegister(server)
    expect(after.contact === "*" ? [] : after.contact.map((entry) => entry.uri)).toEqual(
      before === "*" ? [] : before.map((entry) => entry.uri),
    )
  })

  it("explains a WebSocket that the server refuses", async () => {
    const server = await serve()
    const error = await failure(`ws://alice:secret@127.0.0.1:${server.port}/wrong`)
    expect(error.reason).toBe("network")
    expect(error.message).toContain(`ws://127.0.0.1:${server.port}/wrong`)
    expect(error.message).toContain(
      "check the address, the path, the certificate and that the server speaks SIP over WebSocket",
    )
  })

  it("points at SIP over WebSocket when the server leaves out the sip subprotocol", async () => {
    const server = await serve({ protocol: null })
    const error = await failure(`ws://alice:secret@127.0.0.1:${server.port}/ws`)
    expect(error.reason).toBe("network")
    expect(error.message).toContain("that the server speaks SIP over WebSocket")
  })

  it("opens call audio on the interface that reaches the server, not on its .invalid name", async () => {
    for (const host of ["127.0.0.1", "::1"]) {
      const server = host.includes(":") ? `[${host}]` : host
      const platform = nodePlatform(resolveOptions(`ws://alice@${server}:8088/ws`))
      const audio = await platform.openAudio("a1b2c3d4e5f6.invalid", () => {}, { microphone: true })
      expect("local" in audio && audio.local.host).toBe(host)
      audio.close()
    }
  })

  it("reports its own close at once, even to a server that never answers the close", async () => {
    const server = await startWebSocketServer({
      path: "/ws",
      ignoreClose: true,
      onMessage: () => {},
    })
    cleanups.push(() => server.close())
    const link = await openWebSocket(
      { transport: "WS", host: "127.0.0.1", port: server.port, path: "/ws" },
      "a1b2c3d4e5f6.invalid",
    )
    const close = vi.fn()
    link.start({ receive: vi.fn(), close })
    link.close()
    expect(close).toHaveBeenCalledWith(undefined)
  })
})
