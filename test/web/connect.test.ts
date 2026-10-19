import { afterEach, describe, expect, it, vi } from "vitest"
import * as straw from "../../src"
import * as browser from "../../src/browser"
import { getHeader } from "../../src/core"
import { resolveOptions } from "../../src/phone/options"
import { connectPhone } from "../../src/phone/phone"
import { connect, webPlatform } from "../../src/web/connect"
import { wsRegistrar } from "../node/servers"
import { FakePeer, FakeStream, fakeLocks, fakeMedia, fakeStorage } from "./fakes"

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllGlobals()
})

describe("the browser build", () => {
  it("has the same names as the Node build", () => {
    expect(Object.keys(browser).sort()).toEqual(Object.keys(straw).sort())
    expect(browser.ConnectError).toBe(straw.ConnectError)
  })
})

describe("webPlatform", () => {
  it.each(["udp://alice@example.com", "tls://alice@example.com"])(
    "refuses %s, out of a browser's reach",
    async (url) => {
      await expect(
        webPlatform(resolveOptions(url), fakeMedia(), fakeStorage(), fakeLocks()),
      ).rejects.toThrow(
        new TypeError(
          "Browsers reach SIP only over WebSocket: use wss://user:password@host[:port][/path]",
        ),
      )
    },
  )

  it("makes SDP, keeps its instance and passes on the ICE servers", async () => {
    const storage = fakeStorage()
    const settings = resolveOptions("wss://alice@pbx.example.com/ws", {
      iceServers: [
        { urls: ["stun:a.example.com", "stun:b.example.com"], username: "u", credential: "c" },
        { urls: "stun:c.example.com" },
      ],
    })
    const platform = await webPlatform(settings, fakeMedia(), storage, fakeLocks())
    expect(platform.media).toBe("sdp")
    expect(platform.instance).toMatch(/^urn:uuid:/)
    const reloaded = await webPlatform(settings, fakeMedia(), storage, fakeLocks())
    expect(reloaded.instance).toBe(platform.instance)
    expect(platform.debug).toBeUndefined()
    await platform.openAudio("x.invalid", () => undefined, { microphone: true })
    expect(FakePeer.last?.configuration).toStrictEqual({
      iceServers: [
        { urls: ["stun:a.example.com", "stun:b.example.com"], username: "u", credential: "c" },
        { urls: "stun:c.example.com" },
      ],
    })
  })

  it("registers over WebSocket with the instance it keeps across reloads", async () => {
    const server = await wsRegistrar()
    cleanups.push(() => server.close())
    const storage = fakeStorage()
    const settings = resolveOptions(`ws://alice:secret@127.0.0.1:${server.port}/ws`)
    for (let reload = 0; reload < 2; reload++) {
      const platform = await webPlatform(settings, fakeMedia(), storage, fakeLocks())
      const { phone } = await connectPhone(settings, platform)
      expect(phone.status).toBe("online")
      await phone.close()
    }
    const contacts = server.registrar.registers
      .filter((register) => getHeader(register, "Expires") !== "0")
      .map((register) => (register.contact === "*" ? undefined : register.contact[0]))
    expect(new Set(contacts.map((contact) => contact?.uri)).size).toBe(1)
    expect(new Set(contacts.map((contact) => contact?.params.get("+sip.instance"))).size).toBe(1)
  })
})

describe("connect in the browser", () => {
  it("connects with the browser's own WebRTC and storage", async () => {
    const server = await wsRegistrar()
    cleanups.push(() => server.close())
    vi.stubGlobal("RTCPeerConnection", FakePeer)
    vi.stubGlobal("MediaStream", FakeStream)
    vi.stubGlobal("navigator", { mediaDevices: {}, locks: fakeLocks() })
    vi.stubGlobal("localStorage", fakeStorage())
    const phone = await connect(`ws://alice:secret@127.0.0.1:${server.port}/ws`)
    cleanups.push(() => phone.close())
    expect(phone.status).toBe("online")
  })

  it("refuses a page that can't make calls before it connects", async () => {
    vi.stubGlobal("isSecureContext", false)
    await expect(connect("wss://alice:secret@pbx.example.com/ws")).rejects.toMatchObject({
      name: "SecurityError",
    })
  })
})
