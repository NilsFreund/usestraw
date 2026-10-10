import { createSocket } from "node:dgram"
import {
  type CallEnd,
  type CoreCommand,
  type CoreEvent,
  createCore,
  isRequest,
  parseMessage,
  type TransportAddress,
} from "../../src"
import { type CallAudio, openAudio } from "../../src/node/audio"
import { createRandom } from "../../src/simulation/random"
import { registrar } from "../registrar"

export type Answer =
  | "echo"
  | "ring"
  | { readonly reject: number }
  | { readonly hangupAfter: number }

export interface Carrier {
  readonly port: number
  readonly events: CoreEvent[]
  readonly methods: string[]
  readonly ended: Map<string, CallEnd>
  answer: Answer
  deaf: boolean
  dial(): Promise<string>
  invite(displayName: string): void
  hangup(call: string): void
  close(): Promise<void>
}

const host = "127.0.0.1"

// A carrier on one UDP socket: a registrar for REGISTER and OPTIONS, and a second Straw phone that
// answers the calls it gets with an audio echo and can call the registered phone back
export async function startCarrier(answer: Answer = "echo"): Promise<Carrier> {
  const socket = createSocket("udp4")
  await new Promise<void>((resolve) => socket.bind(0, host, resolve))
  const address: TransportAddress = { transport: "UDP", host, port: socket.address().port }
  const registry = registrar()(createRandom(9))
  const far = createCore({ address, aor: `sip:bob@${host}`, random: createRandom(11) })
  const audios = new Map<string, CallAudio>()
  const events: CoreEvent[] = []
  const methods: string[] = []
  const ended = new Map<string, CallEnd>()
  let phone: TransportAddress | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let counter = 0
  const carrier: Carrier = {
    port: address.port,
    events,
    methods,
    ended,
    answer,
    deaf: false,
    dial,
    invite,
    hangup,
    close,
  }

  function send(outputs: ReturnType<typeof far.handle>): void {
    for (const output of outputs) {
      if (output.type === "send") socket.send(output.data, output.to.port, output.to.host)
      else void notice(output.event)
    }
  }

  function run(input: Parameters<typeof far.handle>[0]): void {
    send(far.handle(input, performance.now()))
    clearTimeout(timer)
    const at = far.nextDeadline()
    if (at !== undefined)
      timer = setTimeout(() => run({ type: "timeout" }), Math.max(0, at - performance.now()))
  }

  const command = (value: CoreCommand) => run({ type: "command", command: value })

  async function notice(event: CoreEvent): Promise<void> {
    events.push(event)
    if (event.type !== "call") return
    if (event.state === "ended") {
      ended.set(event.call, event.ended)
      audios.get(event.call)?.close()
    }
    if (event.state === "live" && event.media) audios.get(event.call)?.update(event.media)
    if (event.state !== "incoming") return
    const behaviour = carrier.answer
    if (behaviour === "ring") return
    if (typeof behaviour === "object" && "reject" in behaviour) {
      command({ type: "end", call: event.call, status: behaviour.reject })
      return
    }
    const audio = await echo(event.call)
    command({ type: "accept", call: event.call, media: audio.local })
    if (typeof behaviour === "object" && "hangupAfter" in behaviour) {
      setTimeout(() => command({ type: "end", call: event.call }), behaviour.hangupAfter)
    }
  }

  async function echo(call: string): Promise<CallAudio> {
    const audio = await openAudio(host)
    audios.set(call, audio)
    void audio.readable.pipeTo(audio.writable).catch(() => undefined)
    return audio
  }

  async function dial(): Promise<string> {
    if (!phone) throw new Error("Nobody registered yet")
    const call = `carrier-${++counter}`
    const audio = await echo(call)
    command({
      type: "call",
      call,
      uri: `sip:alice@${phone.host}:${phone.port}`,
      to: phone,
      media: audio.local,
    })
    return call
  }

  function invite(displayName: string): void {
    if (!phone) throw new Error("Nobody registered yet")
    const sdp =
      "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio 9000 RTP/AVP 0\r\n"
    const text = [
      `INVITE sip:alice@${phone.host}:${phone.port} SIP/2.0`,
      `Via: SIP/2.0/UDP ${host}:${address.port};branch=z9hG4bKraw${++counter}`,
      "Max-Forwards: 70",
      `From: "${displayName}" <sip:+4930555@${host}>;tag=raw`,
      "To: <sip:alice@example.com>",
      `Call-ID: raw-${counter}@${host}`,
      "CSeq: 1 INVITE",
      `Contact: <sip:raw@${host}:${address.port}>`,
      "Content-Type: application/sdp",
      `Content-Length: ${sdp.length}`,
      "",
      sdp,
    ].join("\r\n")
    socket.send(text, phone.port, phone.host)
  }

  function hangup(call: string): void {
    command({ type: "end", call })
  }

  function close(): Promise<void> {
    clearTimeout(timer)
    for (const audio of audios.values()) audio.close()
    return new Promise((resolve) => socket.close(() => resolve()))
  }

  socket.on("message", (data, info) => {
    if (carrier.deaf) return
    const from: TransportAddress = { transport: "UDP", host: info.address, port: info.port }
    const parsed = parseMessage(new Uint8Array(data))
    if (!parsed.ok) return
    const { message } = parsed
    if (isRequest(message)) methods.push(message.method)
    const method = isRequest(message) ? message.method : message.cseq.method
    if (method === "REGISTER" || method === "OPTIONS") {
      if (method === "REGISTER") phone = from
      for (const output of registry.handle(
        { type: "receive", data: new Uint8Array(data), from },
        performance.now(),
      )) {
        if (output.type === "send") socket.send(output.data, output.to.port, output.to.host)
      }
      return
    }
    run({ type: "receive", data: new Uint8Array(data), from })
  })

  return carrier
}
