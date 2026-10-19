import { describe, expect, it, vi } from "vitest"
import type { CoreCommand, RemoteDescription } from "../../src/core"
import { type CallSetup, createCall } from "../../src/phone/call"
import { resolveOptions } from "../../src/phone/options"
import type { AudioOptions, SdpAudio } from "../../src/phone/platform"
import type { LiveCall, RingingCall } from "../../src/phone/types"
import { memoryNetwork, startOn } from "./memory"

const OFFER = "v=0\r\no=far 1 1 IN IP4 192.0.2.20\r\n"
const offer: RemoteDescription = { type: "offer", sdp: OFFER }

interface FakeAudio extends SdpAudio {
  readonly described: (RemoteDescription | undefined)[]
  readonly applied: RemoteDescription[]
  closed: boolean
  lived: number
}

function fakeAudio({ fails = false, refuses = false } = {}): FakeAudio {
  const described: (RemoteDescription | undefined)[] = []
  const applied: RemoteDescription[] = []
  const audio: FakeAudio = {
    described,
    applied,
    closed: false,
    lived: 0,
    sampleRate: 8000,
    played: 0,
    readable: new ReadableStream(),
    writable: new WritableStream(),
    clear: () => undefined,
    close: () => {
      audio.closed = true
    },
    live: () => {
      audio.lived += 1
    },
    describe: async (remote) => {
      described.push(remote)
      if (fails) throw new DOMException("bad SDP", "InvalidAccessError")
      return remote ? "v=0\r\nanswer" : "v=0\r\noffer"
    },
    apply: async (remote) => {
      applied.push(remote)
      if (refuses) throw new DOMException("bad answer", "InvalidAccessError")
    },
  }
  return audio
}

function handle(
  audio: FakeAudio | CallSetup["openAudio"],
  direction: CallSetup["direction"] = "incoming",
  remote: RemoteDescription | null = offer,
) {
  const commands: CoreCommand[] = []
  const created = createCall({
    id: "c1",
    direction,
    from: "bob",
    to: "alice",
    offer: remote ?? undefined,
    openAudio: typeof audio === "function" ? audio : async () => audio,
    run: (command) => commands.push(command),
    changed: () => undefined,
  })
  return { ...created, commands, ringing: created.call as RingingCall }
}

const live = { type: "call", call: "c1", state: "live" } as const

describe("a call whose audio makes its own SDP", () => {
  it("asks for the microphone unless an agent talks", async () => {
    const asked: AudioOptions[] = []
    const open: CallSetup["openAudio"] = async (_, options) => {
      asked.push(options)
      return fakeAudio()
    }
    void handle(open).ringing.accept()
    void handle(open).ringing.accept(new TransformStream())
    await expect.poll(() => asked).toStrictEqual([{ microphone: true }, { microphone: false }])
  })

  it("answers the offer it rang with", async () => {
    const audio = fakeAudio()
    const call = handle(audio)
    void call.ringing.accept()
    await expect
      .poll(() => call.commands)
      .toStrictEqual([{ type: "accept", call: "c1", media: { sdp: "v=0\r\nanswer" } }])
    expect(audio.described).toStrictEqual([offer])
  })

  it("tells the audio once that the call is live, so it forgets what it heard while ringing", async () => {
    const audio = fakeAudio()
    const call = handle(audio)
    void call.ringing.accept()
    await expect.poll(() => call.commands.length).toBe(1)
    expect(audio.lived).toBe(0)
    call.receive(live)
    call.receive(live)
    expect(audio.lived).toBe(1)
  })

  it("leaves the audio's streams alone until the app reaches for them", async () => {
    const touched: string[] = []
    const audio: FakeAudio = {
      ...fakeAudio(),
      get readable() {
        touched.push("readable")
        return new ReadableStream()
      },
      get writable() {
        touched.push("writable")
        return new WritableStream()
      },
    }
    const call = handle(audio)
    const accepting = call.ringing.accept()
    await expect.poll(() => call.commands.length).toBe(1)
    call.receive(live)
    const answered = await accepting
    expect(touched).toStrictEqual([])
    if (answered.ok) void answered.audio.writable
    expect(touched).toStrictEqual(["writable"])
  })

  it("makes the offer when the call rang without one", async () => {
    const audio = fakeAudio()
    const call = handle(audio, "incoming", null)
    void call.ringing.accept()
    await expect
      .poll(() => call.commands)
      .toStrictEqual([{ type: "accept", call: "c1", media: { sdp: "v=0\r\noffer" } }])
  })

  it("turns the call away with 488 when the offer cannot be used", async () => {
    const call = handle(fakeAudio({ fails: true }))
    void call.ringing.accept()
    await expect.poll(() => call.commands).toStrictEqual([{ type: "end", call: "c1", status: 488 }])
  })

  it("does not answer when the caller gave up while the answer was being made", async () => {
    let finish: ((sdp: string) => void) | undefined
    const audio = {
      ...fakeAudio(),
      describe: () => new Promise<string>((resolve) => (finish = resolve)),
    }
    const call = handle(audio)
    const accepting = call.ringing.accept()
    await expect.poll(() => finish).toBeDefined()
    call.receive({
      type: "call",
      call: "c1",
      state: "ended",
      ended: { by: "remote", reason: "cancelled" },
    })
    finish?.("v=0\r\nlate")
    expect(await accepting).toMatchObject({ ok: false, reason: "cancelled" })
    expect(call.commands).toStrictEqual([])
  })

  it("turns the call away with 503 for any other trouble opening the audio", async () => {
    const call = handle(() => Promise.reject(new DOMException("aborted", "AbortError")))
    const accepting = call.ringing.accept()
    await expect.poll(() => call.commands).toStrictEqual([{ type: "end", call: "c1", status: 503 }])
    call.receive({
      type: "call",
      call: "c1",
      state: "ended",
      ended: { by: "local", reason: "unavailable" },
    })
    expect(await accepting).toMatchObject({ ok: false })
  })

  it("sends no answer that was made after the call ended", async () => {
    let finish: (sdp: string) => void = () => undefined
    const audio = {
      ...fakeAudio(),
      describe: () => new Promise<string>((resolve) => (finish = resolve)),
    }
    const call = handle(audio, "outgoing")
    await call.open()
    call.receive({ type: "call", call: "c1", state: "offer", description: offer })
    call.receive({
      type: "call",
      call: "c1",
      state: "ended",
      ended: { by: "remote", reason: "hangup" },
    })
    finish("v=0\r\nlate")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(call.commands).toStrictEqual([])
  })

  it.each([
    "NotAllowedError",
    "NotFoundError",
    "NotReadableError",
    "SecurityError",
    "NotSupportedError",
  ])("keeps ringing on a %s from the browser, and answers on the next try", async (name) => {
    const denied = new DOMException("No microphone", name)
    const audio = fakeAudio()
    const open = vi.fn().mockRejectedValueOnce(denied).mockResolvedValue(audio)
    const call = handle(open)
    await expect(call.ringing.accept()).rejects.toBe(denied)
    expect(call.call.status).toBe("ringing")
    expect(call.commands).toStrictEqual([])
    void call.ringing.accept()
    await expect.poll(() => call.commands).toHaveLength(1)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it("settles as unanswered when the caller gave up while the microphone was asked for", async () => {
    let refuse: (error: unknown) => void = () => undefined
    const call = handle(() => new Promise((_, reject) => (refuse = reject)))
    const accepting = call.ringing.accept()
    call.receive({
      type: "call",
      call: "c1",
      state: "ended",
      ended: { by: "remote", reason: "cancelled" },
    })
    refuse(new DOMException("Permission denied", "NotAllowedError"))
    expect(await accepting).toMatchObject({ ok: false, status: "ended", reason: "cancelled" })
  })

  it("applies the far end's pranswer and answer, and goes live", async () => {
    const audio = fakeAudio()
    const call = handle(audio, "outgoing")
    await call.open()
    const pranswer = { type: "pranswer", sdp: "v=0\r\nearly" } as const
    const answer = { type: "answer", sdp: "v=0\r\nfinal" } as const
    call.receive({ type: "call", call: "c1", state: "ringing", status: 183, description: pranswer })
    call.receive({ ...live, description: answer })
    expect(audio.applied).toStrictEqual([pranswer, answer])
    expect(call.call.status).toBe("live")
  })

  it("hangs up as incompatible when the far end's answer cannot be applied", async () => {
    const call = handle(fakeAudio({ refuses: true }), "outgoing")
    call.place({
      type: "call",
      call: "c1",
      uri: "sip:bob@example.com",
      to: { transport: "WSS", host: "pbx.example.com", port: 443 },
      media: { sdp: "v=0\r\n" },
    })
    await call.open()
    call.receive({ ...live, description: { type: "answer", sdp: "v=0\r\nbad" } })
    await expect.poll(() => call.commands.at(-1)).toStrictEqual({ type: "end", call: "c1" })
    call.receive({
      type: "call",
      call: "c1",
      state: "ended",
      ended: { by: "local", reason: "hangup" },
    })
    expect(await call.call.ended).toStrictEqual({ by: "us", reason: "incompatible" })
  })

  it("answers new offers inside the call, and offers when asked to", async () => {
    const audio = fakeAudio()
    const call = handle(audio)
    void call.ringing.accept()
    await expect.poll(() => call.commands).toHaveLength(1)
    call.receive(live)
    call.receive({ type: "call", call: "c1", state: "offer", description: offer })
    call.receive({ type: "call", call: "c1", state: "offer" })
    await expect
      .poll(() => call.commands.slice(1))
      .toStrictEqual([
        { type: "answer", call: "c1", media: { sdp: "v=0\r\nanswer" } },
        { type: "answer", call: "c1", media: { sdp: "v=0\r\noffer" } },
      ])
  })

  it("leaves an offer it cannot answer to the core's timeout, and ignores offers once over", async () => {
    const audio = fakeAudio({ fails: true })
    const call = handle(audio)
    await call.open()
    call.receive({ type: "call", call: "c1", state: "offer", description: offer })
    await expect.poll(() => audio.described).toHaveLength(1)
    call.receive({
      type: "call",
      call: "c1",
      state: "ended",
      ended: { by: "remote", reason: "hangup" },
    })
    call.receive({ type: "call", call: "c1", state: "offer", description: offer })
    expect(call.commands).toStrictEqual([])
  })

  it("does nothing with descriptions before its audio is open", () => {
    const call = handle(fakeAudio(), "outgoing")
    call.receive({ type: "call", call: "c1", state: "offer", description: offer })
    call.receive({
      type: "call",
      call: "c1",
      state: "ringing",
      status: 180,
      description: { type: "pranswer", sdp: "v=0\r\n" },
    })
    expect(call.commands).toStrictEqual([])
  })
})

describe("a phone whose platform makes the SDP", () => {
  it("calls with the platform's offer", async () => {
    vi.useFakeTimers()
    try {
      const network = memoryNetwork()
      const audio = fakeAudio()
      const phone = await startOn(network, resolveOptions("udp://alice:secret@example.com"), {
        openAudio: async () => audio,
        media: "sdp",
      })
      const calling = phone.call("bob")
      await vi.waitFor(() => expect(audio.described).toStrictEqual([undefined]))
      const call = (await Promise.race([
        calling,
        vi.advanceTimersByTimeAsync(40_000).then(() => calling),
      ])) as LiveCall
      expect(call.ok).toBe(false)
      await phone.close({ signal: AbortSignal.timeout(1) }).catch(() => undefined)
    } finally {
      vi.useRealTimers()
    }
  })

  it("ends a call whose offer cannot be made, and says why", async () => {
    vi.useFakeTimers()
    try {
      const network = memoryNetwork()
      const phone = await startOn(network, resolveOptions("udp://alice:secret@example.com"), {
        openAudio: async () => fakeAudio({ fails: true }),
        media: "sdp",
      })
      await expect(phone.call("bob")).rejects.toMatchObject({ name: "InvalidAccessError" })
      expect(phone.calls).toStrictEqual([])
      await phone.close({ signal: AbortSignal.timeout(1) }).catch(() => undefined)
    } finally {
      vi.useRealTimers()
    }
  })

  it("sends no offer made after the caller gave up, and rejects with the signal's reason", async () => {
    const network = memoryNetwork()
    let finish: ((sdp: string) => void) | undefined
    const audio = {
      ...fakeAudio(),
      describe: () => new Promise<string>((resolve) => (finish = resolve)),
    }
    const phone = await startOn(network, resolveOptions("udp://alice:secret@example.com"), {
      openAudio: async () => audio,
      media: "sdp",
    })
    const controller = new AbortController()
    const calling = phone.call("bob", { signal: controller.signal })
    await expect.poll(() => finish).toBeDefined()
    const sent = network.sent
    controller.abort(new Error("gave up"))
    finish?.("v=0\r\nlate")
    await expect(calling).rejects.toThrow("gave up")
    expect(network.sent).toBe(sent)
    await phone.close()
  })

  it("rejects with the signal's reason when the microphone is refused after the caller gave up", async () => {
    const network = memoryNetwork()
    let refuse: ((error: unknown) => void) | undefined
    const phone = await startOn(network, resolveOptions("udp://alice:secret@example.com"), {
      openAudio: () => new Promise((_, reject) => (refuse = reject)),
      media: "sdp",
    })
    const controller = new AbortController()
    const calling = phone.call("bob", { signal: controller.signal })
    await expect.poll(() => refuse).toBeDefined()
    controller.abort(new Error("gave up"))
    refuse?.(new DOMException("Permission denied", "NotAllowedError"))
    await expect(calling).rejects.toThrow("gave up")
    await phone.close()
  })

  it("hands a ringing call's offer to the audio when it is answered", async () => {
    vi.useFakeTimers()
    try {
      const network = memoryNetwork()
      const audio = fakeAudio()
      const phone = await startOn(network, resolveOptions("udp://alice:secret@example.com"), {
        openAudio: async () => audio,
        media: "sdp",
      })
      const body = "v=0\r\no=far 1 1 IN IP4 192.0.2.20\r\n"
      network.inject(
        new TextEncoder().encode(
          [
            "INVITE sip:alice@192.0.2.10:5060 SIP/2.0",
            "Via: SIP/2.0/UDP 192.0.2.20:5060;branch=z9hG4bKsdp1;rport",
            "Max-Forwards: 70",
            "From: <sip:bob@example.com>;tag=b1",
            "To: <sip:alice@example.com>",
            "Call-ID: sdp-in-1",
            "CSeq: 1 INVITE",
            "Contact: <sip:bob@192.0.2.20:5060>",
            "Content-Type: application/sdp",
            `Content-Length: ${body.length}`,
            "",
            body,
          ].join("\r\n"),
        ),
      )
      const ringing = (await phone.incoming[Symbol.asyncIterator]().next()).value as RingingCall
      void ringing.accept()
      await vi.waitFor(() => expect(audio.described).toStrictEqual([{ type: "offer", sdp: body }]))
      // The far end never acknowledges, so the call runs out on its own timers before the phone closes
      const closing = phone.close()
      await vi.advanceTimersByTimeAsync(120_000)
      await closing
    } finally {
      vi.useRealTimers()
    }
  })
})
