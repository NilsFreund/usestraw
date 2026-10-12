import { afterEach, describe, expect, it } from "vitest"
import { connect, type LiveCall, type Phone } from "../../src"
import { nodePlatform } from "../../src/node/connect"
import { targetUri, userOf } from "../../src/phone/call-list"
import { resolveOptions } from "../../src/phone/options"
import { connectPhone } from "../../src/phone/phone"
import { pause, sdp, tone } from "../helpers"
import { type Answer, type Carrier, startCarrier } from "../node/carrier"
import { memoryNetwork, startOn } from "./memory"

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(
  answer: Answer = "echo",
  maxCalls?: number,
): Promise<{ carrier: Carrier; phone: Phone }> {
  const carrier = await startCarrier(answer)
  cleanups.push(() => carrier.close())
  const phone = await connect({
    uri: "sip:alice@example.com",
    password: "secret",
    server: `udp://127.0.0.1:${carrier.port}`,
    trace: false,
    ...(maxCalls === undefined ? {} : { maxCalls }),
  })
  cleanups.push(() => phone.close())
  return { carrier, phone }
}

const loud = (pcm: Int16Array) => pcm.some((value) => Math.abs(value) > 4000)

async function hearsBack(call: LiveCall): Promise<boolean> {
  const writer = call.audio.writable.getWriter()
  void writer.write(tone(4000)).catch(() => undefined)
  writer.releaseLock()
  const reader = call.audio.readable.getReader()
  for (let frame = 0; frame < 50; frame++) {
    const { value } = await reader.read()
    if (value && loud(value)) {
      reader.releaseLock()
      return true
    }
  }
  reader.releaseLock()
  return false
}

describe("phone.call", () => {
  it("calls a number written like people write it and talks once answered", async () => {
    const { phone, carrier } = await setup()
    const seen: string[] = []
    phone.subscribe(() => seen.push(phone.calls.map((call) => call.status).join()))
    const call = await phone.call("+49 (30) 123-4567")
    expect(call.ok).toBe(true)
    if (!call.ok) return
    expect(call).toMatchObject({
      status: "live",
      direction: "outgoing",
      from: "alice",
      to: "+49301234567",
    })
    expect(call.audio.sampleRate).toBe(8000)
    expect(await hearsBack(call)).toBe(true)
    await expect.poll(() => call.audio.played).toBeGreaterThan(0)
    expect(phone.calls).toStrictEqual([call])
    expect(await call.end()).toStrictEqual({ by: "us", reason: "hangup" })
    expect(call).toMatchObject({ status: "ended", ok: true, reason: "hangup" })
    expect(phone.calls).toStrictEqual([])
    expect(seen).toContain("calling")
    expect(seen).toContain("live")
    expect(carrier.methods).toContain("BYE")
  })

  it("settles a busy line as a result, not an error", async () => {
    const { phone } = await setup({ reject: 486 })
    const call = await phone.call("+4930999")
    expect(call).toMatchObject({ ok: false, status: "ended", reason: "busy" })
    expect(await call.ended).toStrictEqual({ by: "them", reason: "busy" })
  })

  it("lets an agent talk for the whole call", async () => {
    const { phone } = await setup()
    let frames = 0
    const agent = new TransformStream<Int16Array, Int16Array<ArrayBuffer>>({
      transform: (pcm, controller) => {
        frames++
        controller.enqueue(new Int16Array(pcm))
      },
    })
    const call = await phone.call("sip:bob@example.com", { agent })
    expect(call.ok).toBe(true)
    await expect.poll(() => frames).toBeGreaterThan(5)
    await call.end()
  })

  it("gives up like fetch when its signal aborts while it rings", async () => {
    const { phone, carrier } = await setup("ring")
    const controller = new AbortController()
    const calling = phone.call("bob", { signal: controller.signal })
    await expect.poll(() => carrier.methods).toContain("INVITE")
    expect(phone.calls.map((call) => call.status)).toStrictEqual(["calling"])
    controller.abort(new Error("enough"))
    await expect(calling).rejects.toThrow("enough")
    await expect.poll(() => carrier.methods).toContain("CANCEL")
    expect(phone.calls).toStrictEqual([])
  })

  it("refuses an aborted signal, a closed phone and an address it cannot call", async () => {
    const { phone } = await setup()
    const seen: number[] = []
    phone.subscribe(() => seen.push(phone.calls.length))
    await expect(phone.call("bob", { signal: AbortSignal.abort(new Error("no")) })).rejects.toThrow(
      "no",
    )
    await expect(phone.call("sip:bob@bad host")).rejects.toThrow(
      'Cannot call "sip:bob@bad host": use a number, a user name or sip:user@host',
    )
    await expect(phone.call("tel:bob")).rejects.toThrow('Cannot call "tel:bob"')
    for (const half of [
      "",
      "   ",
      "bob@",
      "@host.example",
      "sip:bob@",
      "sip:@host.example",
      "bob@:5060",
    ]) {
      await expect(phone.call(half)).rejects.toThrow(`Cannot call ${JSON.stringify(half)}`)
    }
    expect(phone.calls).toStrictEqual([])
    expect(seen).toStrictEqual([])
    await phone.close()
    await expect(phone.call("bob")).rejects.toMatchObject({ name: "InvalidStateError" })
    await expect(phone.call("")).rejects.toThrow(TypeError)
  })

  it("settles as no answer when the ring timeout runs out", async () => {
    const { phone, carrier } = await setup("ring")
    const call = await phone.call("bob", { timeout: 150 })
    expect(call).toMatchObject({ ok: false, reason: "no-answer" })
    expect(await call.ended).toStrictEqual({ by: "us", reason: "no-answer" })
    await expect.poll(() => carrier.methods).toContain("CANCEL")
  })

  it("never places a call aborted or closed before its audio was ready", async () => {
    const { phone, carrier } = await setup()
    const controller = new AbortController()
    const aborted = phone.call("bob", { signal: controller.signal })
    controller.abort(new Error("changed my mind"))
    await expect(aborted).rejects.toThrow("changed my mind")
    const closing = phone.call("bob")
    await phone.close()
    expect(await closing).toMatchObject({ ok: false, reason: "cancelled" })
    expect(carrier.methods).not.toContain("INVITE")
  })

  it("refuses an agent that was already used, and a timeout that is no duration", async () => {
    const { phone, carrier } = await setup()
    const agent = new TransformStream<Int16Array, Int16Array<ArrayBuffer>>()
    agent.readable.getReader()
    await expect(phone.call("bob", { agent })).rejects.toThrow(
      new TypeError("This agent was already used for a call: create a new agent for each call"),
    )
    await expect(phone.call("bob", { timeout: 0 })).rejects.toThrow(
      new RangeError(
        "The timeout must be a whole number of milliseconds from 1 to 2147483647, got 0",
      ),
    )
    expect(carrier.methods).not.toContain("INVITE")
  })

  it("hangs up when the agent is done talking or fails", async () => {
    const { phone } = await setup()
    const done = new TransformStream<Int16Array, Int16Array<ArrayBuffer>>({
      transform: (_, controller) => controller.terminate(),
    })
    const finished = await phone.call("bob", { agent: done })
    expect(await finished.ended).toStrictEqual({ by: "us", reason: "hangup" })
    const broken = new TransformStream<Int16Array, Int16Array<ArrayBuffer>>({
      transform: () => {
        throw new Error("model crashed")
      },
    })
    const failed = await phone.call("bob", { agent: broken })
    expect(await failed.ended).toStrictEqual({ by: "us", reason: "hangup" })
  })

  it("keeps an answered call when the signal aborts later", async () => {
    const { phone } = await setup()
    const controller = new AbortController()
    const call = await phone.call("bob", { signal: controller.signal })
    controller.abort()
    await pause(50)
    expect(call.status).toBe("live")
    await call.end()
  })
})

describe("call data", () => {
  it("keeps one snapshot of the calls until something changes", async () => {
    const { phone } = await setup()
    const before = phone.calls
    expect(phone.calls).toBe(before)
    const call = await phone.call("bob")
    expect(phone.calls).not.toBe(before)
    expect(phone.calls).toBe(phone.calls)
    expect(Object.isFrozen(phone.calls)).toBe(true)
    const live = call.toJSON()
    expect(call.toJSON()).toBe(live)
    expect(Object.isFrozen(live)).toBe(true)
    expect(JSON.parse(JSON.stringify(call))).toStrictEqual({
      id: call.id,
      direction: "outgoing",
      from: "alice",
      to: "bob",
      status: "live",
      ok: true,
    })
    await call.end()
    expect(call.toJSON()).not.toBe(live)
    expect(call.toJSON()).toMatchObject({ status: "ended", reason: "hangup" })
    const { inspect } = await import("node:util")
    expect(inspect(call)).toContain("reason: 'hangup'")
  })

  it("has the phone's data up to date when a call's listeners run, and tells once per change", async () => {
    const { phone } = await setup()
    const call = await phone.call("bob")
    const seen: string[] = []
    call.subscribe(() =>
      seen.push(
        phone
          .toJSON()
          .calls.map((data) => data.status)
          .join() || "none",
      ),
    )
    let told = 0
    phone.subscribe(() => told++)
    await call.end()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toStrictEqual(["none"])
    expect(told).toBe(1)
  })

  it("shows the phone as frozen plain data without its trace, the same until it changes", async () => {
    const { phone } = await setup()
    const idle = phone.toJSON()
    expect(idle).toStrictEqual({ status: "online", calls: [] })
    expect(phone.toJSON()).toBe(idle)
    expect(Object.isFrozen(idle) && Object.isFrozen(idle.calls)).toBe(true)
    expect(JSON.stringify(phone)).toBe('{"status":"online","calls":[]}')
    const { inspect } = await import("node:util")
    expect(inspect(phone)).toBe("{ status: 'online', calls: [] }")
    const call = await phone.call("bob")
    expect(phone.toJSON()).not.toBe(idle)
    expect(phone.toJSON().calls).toStrictEqual([call.toJSON()])
    await call.end()
    expect(phone.toJSON()).toStrictEqual({ status: "online", calls: [] })
  })
})

describe("phone.incoming", () => {
  it("rings, gets accepted with an agent and ends when the caller hangs up", async () => {
    const { phone, carrier } = await setup()
    const id = await carrier.dial()
    for await (const call of phone.incoming) {
      expect(call).toMatchObject({
        status: "ringing",
        direction: "incoming",
        from: "bob",
        to: "alice",
        ok: false,
      })
      const statuses: string[] = []
      call.subscribe(() => statuses.push(call.status))
      const accepting = call.accept(new TransformStream())
      expect(call.status).toBe("answering")
      expect(phone.calls.map((each) => each.status)).toStrictEqual(["answering"])
      const answered = await accepting
      expect(answered.ok).toBe(true)
      await pause(200)
      carrier.hangup(id)
      expect(await call.ended).toStrictEqual({ by: "them", reason: "hangup" })
      expect(statuses).toStrictEqual(["answering", "live", "ended"])
      break
    }
  })

  it("turns a call down as declined, or busy by default", async () => {
    const { phone, carrier } = await setup()
    const first = await carrier.dial()
    const iterator = phone.incoming[Symbol.asyncIterator]()
    const { value: declined } = await iterator.next()
    expect(await declined?.end({ reason: "declined" })).toStrictEqual({
      by: "us",
      reason: "declined",
    })
    await expect
      .poll(() => carrier.ended.get(first))
      .toMatchObject({
        by: "remote",
        reason: "declined",
        status: 603,
      })
    const second = await carrier.dial()
    const { value: busy } = await iterator.next()
    await busy?.end()
    await expect
      .poll(() => carrier.ended.get(second))
      .toMatchObject({ reason: "busy", status: 486 })
  })

  it("keeps the first agent when accept is called twice, and refuses a busy agent", async () => {
    const { phone, carrier } = await setup()
    await carrier.dial()
    for await (const call of phone.incoming) {
      let frames = 0
      const agent = new TransformStream<Int16Array, Int16Array<ArrayBuffer>>({
        transform: (pcm, controller) => {
          frames++
          controller.enqueue(new Int16Array(pcm))
        },
      })
      const first = call.accept(agent)
      const second = call.accept()
      expect(second).toBe(first)
      await first
      await expect.poll(() => frames).toBeGreaterThan(3)
      await expect(call.accept(agent)).resolves.toMatchObject({ ok: true })
      break
    }
    await carrier.dial()
    for await (const call of phone.incoming) {
      const busy = new TransformStream<Int16Array, Int16Array<ArrayBuffer>>()
      busy.writable.getWriter()
      await expect(call.accept(busy)).rejects.toThrow("create a new agent for each call")
      expect(call.status).toBe("ringing")
      await call.end()
      break
    }
  })

  it("hangs up when the scope that accepted the call ends", async () => {
    const { phone, carrier } = await setup()
    const id = await carrier.dial()
    for await (const call of phone.incoming) {
      {
        await using live = await call.accept()
        expect(live.status).toBe("live")
      }
      expect(call.status).toBe("ended")
      break
    }
    await expect.poll(() => carrier.ended.get(id)).toMatchObject({ by: "remote", reason: "hangup" })
  })

  it("skips calls that stopped ringing before anyone looked, and accepting them changes nothing", async () => {
    const { phone, carrier } = await setup()
    const id = await carrier.dial()
    await expect.poll(() => phone.calls).toHaveLength(1)
    const [call] = phone.calls
    carrier.hangup(id)
    await expect.poll(() => call?.status).toBe("ended")
    if (call?.status === "ended") expect(call.reason).toBe("cancelled")
    const accepting = await (call as unknown as { accept(): Promise<unknown> }).accept()
    expect(accepting).toMatchObject({ ok: false, status: "ended" })
    const next = await carrier.dial()
    const iterator = phone.incoming[Symbol.asyncIterator]()
    const { value } = await iterator.next()
    expect(value?.id).not.toBe(call?.id)
    await value?.end()
    void next
  })

  it("hands out a call that rang before anyone looked, with the caller's name", async () => {
    const { phone, carrier } = await setup()
    const early = await carrier.dial()
    await expect.poll(() => phone.calls).toHaveLength(1)
    carrier.hangup(early)
    await expect.poll(() => phone.calls).toHaveLength(0)
    carrier.invite("Dr. Müller")
    await expect
      .poll(() => phone.calls.map((call) => call.callerName))
      .toStrictEqual(["Dr. Müller"])
    for await (const call of phone.incoming) {
      expect(call).toMatchObject({ from: "+4930555", callerName: "Dr. Müller", status: "ringing" })
      expect(call.toJSON()).toMatchObject({ callerName: "Dr. Müller" })
      await call.end()
      break
    }
  })

  it("ends at once for whoever iterates after the phone closed", async () => {
    const { phone } = await setup()
    await phone.close()
    const iterator = phone.incoming[Symbol.asyncIterator]()
    expect(await iterator.next()).toStrictEqual({ value: undefined, done: true })
    expect(await iterator.return?.()).toStrictEqual({ value: undefined, done: true })
  })

  it("turns away calls beyond maxCalls as busy", async () => {
    const { phone, carrier } = await setup("echo", 1)
    await carrier.dial()
    await expect.poll(() => phone.calls).toHaveLength(1)
    const second = await carrier.dial()
    await expect
      .poll(() => carrier.ended.get(second))
      .toMatchObject({ reason: "busy", status: 486 })
    expect(phone.calls).toHaveLength(1)
  })
})

describe("phone.close", () => {
  it("hangs up running calls and ends the incoming stream", async () => {
    const { phone, carrier } = await setup()
    const call = await phone.call("bob")
    const listening = (async () => {
      for await (const ringing of phone.incoming) void ringing
      return "done"
    })()
    await phone.close()
    expect(await call.ended).toStrictEqual({ by: "us", reason: "hangup" })
    expect(await listening).toBe("done")
    expect(carrier.methods).toContain("BYE")
  })

  it("turns down calls that still ring when it starts draining", async () => {
    const { phone, carrier } = await setup()
    const ringing = await carrier.dial()
    await expect.poll(() => phone.calls).toHaveLength(1)
    await phone.close({ drain: true })
    expect(carrier.ended.get(ringing)).toMatchObject({ reason: "busy" })
  })

  it("stops draining and hangs up when its signal aborts", async () => {
    const { phone } = await setup()
    const call = await phone.call("bob")
    const controller = new AbortController()
    const closing = phone.close({ drain: true, signal: controller.signal })
    await pause(50)
    expect(call.status).toBe("live")
    controller.abort()
    await closing
    expect(await call.ended).toStrictEqual({ by: "us", reason: "hangup" })
    const quick = await setup()
    const second = await quick.phone.call("bob")
    await quick.phone.close({ drain: true, signal: AbortSignal.abort() })
    expect(second.status).toBe("ended")
  })

  it("cancels a call that was still getting ready when the drain began", async () => {
    const { phone, carrier } = await setup()
    const calling = phone.call("bob")
    await phone.close({ drain: true })
    expect(await calling).toMatchObject({ ok: false, reason: "cancelled" })
    expect(carrier.methods).not.toContain("INVITE")
  })

  it("waits for running calls to end on drain and turns new ones away", async () => {
    const { phone, carrier } = await setup({ hangupAfter: 300 })
    const call = await phone.call("bob")
    const closing = phone.close({ drain: true })
    const late = await carrier.dial()
    await expect.poll(() => carrier.ended.get(late)).toMatchObject({ reason: "busy" })
    expect(call.status).toBe("live")
    await closing
    expect(await call.ended).toStrictEqual({ by: "them", reason: "hangup" })
  })
})

describe("who may call", () => {
  const stranger = { transport: "UDP", host: "203.0.113.9", port: 5060 } as const
  const body = sdp({ host: "203.0.113.9" })
  const invite = new TextEncoder().encode(
    [
      "INVITE sip:alice@192.0.2.10 SIP/2.0",
      "Via: SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bKstranger",
      "Max-Forwards: 70",
      "From: <sip:spam@203.0.113.9>;tag=s1",
      "To: <sip:alice@example.com>",
      "Call-ID: stranger-1",
      "CSeq: 1 INVITE",
      "Contact: <sip:spam@203.0.113.9>",
      "Content-Type: application/sdp",
      `Content-Length: ${body.length}`,
      "",
      body,
    ].join("\r\n"),
  )

  async function ringsFor(acceptFrom: "server" | "anyone") {
    const network = memoryNetwork()
    const phone = await startOn(network, {
      ...resolveOptions({ uri: "sip:alice@example.com", password: "secret", acceptFrom }),
      trace: false,
    })
    cleanups.push(() => phone.close())
    const sent = network.sent
    network.inject(invite, stranger)
    return { phone, answered: network.sent > sent }
  }

  it("ignores a stranger's call by default, without a word", async () => {
    const { phone, answered } = await ringsFor("server")
    expect(phone.calls).toStrictEqual([])
    expect(answered).toBe(false)
  })

  it("rings for anyone when asked to", async () => {
    const { phone } = await ringsFor("anyone")
    expect(phone.calls).toMatchObject([{ from: "spam", status: "ringing" }])
  })
})

describe("phone.call without a free audio port", () => {
  it("rejects and leaves no call behind", async () => {
    const network = memoryNetwork()
    const phone = await startOn(network, {
      ...resolveOptions({
        uri: "sip:alice@example.com",
        password: "secret",
        server: "udp://192.0.2.20",
      }),
      trace: false,
    })
    cleanups.push(() => phone.close())
    await expect(phone.call("bob")).rejects.toMatchObject({ code: "EADDRNOTAVAIL" })
    expect(phone.calls).toStrictEqual([])
  })
})

describe("phone.close when the far end stops answering", () => {
  it("ends its calls itself once the close timeout runs out", async () => {
    const carrier = await startCarrier()
    cleanups.push(() => carrier.close())
    const settings = resolveOptions({
      uri: "sip:alice@example.com",
      password: "secret",
      server: `udp://127.0.0.1:${carrier.port}`,
      trace: false,
    })
    const { phone } = await connectPhone({ ...settings, closeTimeout: 200 }, nodePlatform(settings))
    const call = await phone.call("bob")
    carrier.deaf = true
    await phone.close()
    expect(await call.ended).toStrictEqual({ by: "us", reason: "dropped" })
    expect(phone.calls).toStrictEqual([])
  })
})

describe("addressing", () => {
  it.each([
    ["+49 30 123 4567", "sip:+49301234567@example.com"],
    ["(030) 123-45.67", "sip:030123456 7@example.com".replace(" ", "")],
    ["bob", "sip:bob@example.com"],
    ["bob@other.example", "sip:bob@other.example"],
    ["sips:bob@other.example", "sips:bob@other.example"],
    ["  110  ", "sip:110@example.com"],
    [" +49 30 123", "sip:+4930123@example.com"],
    [" bob ", "sip:bob@example.com"],
    ["-", "sip:-@example.com"],
    ["tel:+49-30-123-4567", "sip:+49301234567@example.com"],
    ["TEL:110", "sip:110@example.com"],
    ["tel: +4930123", "sip:+4930123@example.com"],
    ["tel:%2B4930123", "sip:+4930123@example.com"],
    ["tel:7042;phone-context=example.com", "sip:7042@example.com"],
    ["tel:+4930123;isub=12", "sip:+4930123@example.com"],
    ["+49 (0)30 1234567", "sip:+49301234567@example.com"],
    ["tel:+44 (0)20 7946 0000", "sip:+442079460000@example.com"],
    ["(030) 1234567", "sip:0301234567@example.com"],
    ["02.123.45.67", "sip:021234567@example.com"],
  ])("dials %s as %s", (input, uri) => {
    expect(targetUri(input, "example.com")).toBe(uri)
  })

  it.each([
    ["tel:bob", "use a number"],
    ["tel:", "use a number"],
    ["tel:*21#", "use a number"],
    ["tel:%E0%A4%A", "use a number"],
    ["tel:+4930123;ext=12", "extensions in tel: links are not supported"],
    ["+", "use a number"],
    ["+bob", "use a number"],
    ["192.168.1.10", "use a number"],
  ])("refuses %s", (input, message) => {
    expect(() => targetUri(input, "example.com")).toThrow(message)
  })

  it.each([
    ["sip:+4930123@example.com", "+4930123"],
    ["sip:example.com", "example.com"],
    ["tel:+4930123", "+4930123"],
  ])("names %s as %s", (uri, name) => {
    expect(userOf(uri)).toBe(name)
  })
})
