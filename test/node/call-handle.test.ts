import { describe, expect, it } from "vitest"
import type { Command } from "../../src"
import { type Agent, type CallSetup, createCall } from "../../src/node/calls"

const media = {
  remote: { host: "127.0.0.1", port: 9000 },
  codec: "PCMU",
  payloadType: 0,
  ptime: 20,
  direction: "sendrecv",
} as const

function handle(direction: CallSetup["direction"] = "incoming", host = "127.0.0.1", agent?: Agent) {
  const commands: Command[] = []
  const created = createCall({
    id: "c1",
    direction,
    from: "bob",
    to: "alice",
    host,
    ...(agent ? { agent } : {}),
    run: (command) => commands.push(command),
    changed: () => undefined,
  })
  return { ...created, commands }
}

const placing = {
  type: "call",
  call: "c1",
  uri: "sip:bob@example.com",
  to: { transport: "UDP", host: "127.0.0.1", port: 5060 },
  media: { port: 4000 },
} as const

const ended = (reason: "cancelled" | "hangup" = "cancelled") =>
  ({ type: "call", call: "c1", state: "ended", ended: { by: "remote", reason } }) as const

describe("a call's own state", () => {
  it("closes audio it opened after the call had already ended", async () => {
    const call = handle()
    const opening = call.open()
    call.receive(ended())
    const audio = await opening
    const reader = audio.readable.getReader()
    expect(await reader.read()).toStrictEqual({ done: true, value: undefined })
  })

  it("does not answer when the caller gave up while the audio opened", async () => {
    const call = handle()
    const accepting = (call.call as unknown as { accept(): Promise<unknown> }).accept()
    call.receive(ended())
    expect(await accepting).toMatchObject({ ok: false, status: "ended", reason: "cancelled" })
    expect(call.commands).toStrictEqual([])
  })

  it("turns the call away with 503 instead of throwing when it cannot open audio", async () => {
    const call = handle("incoming", "192.0.2.1")
    const accepting = (call.call as unknown as { accept(): Promise<unknown> }).accept()
    await expect.poll(() => call.commands).toStrictEqual([{ type: "end", call: "c1", status: 503 }])
    call.receive({
      type: "call",
      call: "c1",
      state: "ended",
      ended: { by: "local", reason: "unavailable", status: 503 },
    })
    expect(await accepting).toMatchObject({ ok: false, reason: "unavailable" })
  })

  it("goes live without media for a late offer and stays live on later updates", async () => {
    const call = handle("outgoing")
    const seen: string[] = []
    call.call.subscribe(() => seen.push(call.call.status))
    call.receive({ type: "call", call: "c1", state: "live" })
    call.receive({ type: "call", call: "c1", state: "live", media })
    expect(seen).toStrictEqual(["live"])
    call.receive(ended("hangup"))
    call.receive(ended("hangup"))
    expect(seen).toStrictEqual(["live", "ended"])
    expect(await call.call.end()).toStrictEqual({ by: "them", reason: "hangup" })
    expect(call.commands).toStrictEqual([])
  })

  it("hangs up when its agent was taken by someone else before the answer", async () => {
    const agent = new TransformStream<Int16Array, Int16Array<ArrayBuffer>>()
    const call = handle("outgoing", "127.0.0.1", agent)
    await call.open()
    call.place(placing)
    agent.writable.getWriter()
    call.receive({ type: "call", call: "c1", state: "live", media })
    expect(call.commands).toStrictEqual([placing, { type: "end", call: "c1" }])
  })

  it("closes its audio when the call ends", async () => {
    const call = handle()
    const audio = await call.open()
    call.receive(ended("hangup"))
    expect(await audio.readable.getReader().read()).toStrictEqual({
      done: true,
      value: undefined,
    })
  })

  it("leaves a call that already ended alone, and opens no audio for it", async () => {
    const call = handle()
    call.receive(ended())
    const accepted = await (call.call as unknown as { accept(): Promise<unknown> }).accept()
    expect(accepted).toMatchObject({ ok: false, reason: "cancelled" })
    expect(await call.call.end()).toStrictEqual({ by: "them", reason: "cancelled" })
    expect((call.call as unknown as { audio: unknown }).audio).toBeUndefined()
    expect(call.commands).toStrictEqual([])
  })

  it.each([
    ["busy", 486],
    ["declined", 603],
  ] as const)("turns a ringing call down as %s with %i", (reason, status) => {
    const call = handle()
    void call.call.end({ reason })
    expect(call.commands).toStrictEqual([{ type: "end", call: "c1", status }])
  })

  it("keeps its own reason when the far end ends the call it gave up on", async () => {
    const call = handle("outgoing")
    call.place(placing)
    call.giveUp("no-answer")
    call.receive({
      type: "call",
      call: "c1",
      state: "ended",
      ended: { by: "remote", reason: "busy", status: 486 },
    })
    expect(await call.call.ended).toStrictEqual({ by: "us", reason: "no-answer" })
  })

  it("only gives up on a call that is still calling", async () => {
    const call = handle("outgoing")
    call.place(placing)
    call.receive({ type: "call", call: "c1", state: "live" })
    call.giveUp("no-answer")
    expect(call.call.status).toBe("live")
    expect(call.commands).toHaveLength(1)
  })
})
