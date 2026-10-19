import { describe, expect, it } from "vitest"
import {
  type CoreEvent,
  type CoreInput,
  type CoreOutput,
  createCore,
  createResponse,
  isRequest,
  parseMessage,
  replay,
  type SipMessage,
  type SipRequest,
  serializeMessage,
  type TransportAddress,
} from "../../src/core"
import { createRecordedCore } from "../../src/recorder/recorder"
import { createRandom } from "../../src/simulation/random"
import { aliceMedia, bytes } from "../helpers"
import { events } from "./support"

const local: TransportAddress = { transport: "WSS", host: "a1b2c3d4e5f6.invalid", port: 0 }
const server: TransportAddress = { transport: "WSS", host: "pbx.example.com", port: 443 }
const decoder = new TextDecoder()

function texts(outputs: CoreOutput[]): string[] {
  return outputs.flatMap((output) => (output.type === "send" ? [decoder.decode(output.data)] : []))
}

function messages(outputs: CoreOutput[]): SipMessage[] {
  return texts(outputs).map((text) => {
    const result = parseMessage(bytes(text))
    if (!result.ok) throw new Error(result.error)
    return result.message
  })
}

function request(outputs: CoreOutput[]): SipRequest {
  const [message] = messages(outputs)
  if (!message || !isRequest(message)) throw new Error("Expected a request")
  return message
}

const core = () =>
  createCore({ address: local, aor: "sip:alice@example.com", random: createRandom(1) })

const registerCommand = {
  type: "command",
  command: { type: "register", to: server, registrar: "sip:example.com" },
} as const

describe("the core over WebSocket", () => {
  it("registers with an RFC 7118 Via and Contact and RFC 5626 outbound", () => {
    const [text = ""] = texts(core().handle(registerCommand, 0))
    expect(text).toMatch(
      /^Via: SIP\/2\.0\/WSS a1b2c3d4e5f6\.invalid;branch=z9hG4bK[a-z0-9]{16};rport\r$/m,
    )
    expect(text).toMatch(
      /^Contact: <sip:alice@a1b2c3d4e5f6\.invalid;transport=ws>;reg-id=1;\+sip\.instance="<urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}>"\r$/m,
    )
    expect(text).toMatch(/^Supported: path, outbound\r$/m)
  })

  it("keeps one instance id across REGISTERs", () => {
    const phone = core()
    const first = request(phone.handle(registerCommand, 0))
    const ok = createResponse(first, 200, "OK", {
      toTag: "r1",
      headers: [{ name: "Expires", value: "600" }],
    })
    phone.handle({ type: "receive", data: serializeMessage(ok), from: server }, 10)
    const last = request(phone.handle({ type: "command", command: { type: "unregister" } }, 20))
    const instance = (message: SipRequest) =>
      message.contact === "*" ? undefined : message.contact[0]?.params.get("+sip.instance")
    expect(instance(last)).toBe(instance(first))
    expect(instance(first)).toMatch(/^"<urn:uuid:/)
  })

  it("takes answers from a server it knows by name only, as a browser does", () => {
    const phone = core()
    const register = request(phone.handle(registerCommand, 0))
    const ok = createResponse(register, 200, "OK", {
      toTag: "r1",
      headers: [{ name: "Expires", value: "600" }],
    })
    const outputs = phone.handle({ type: "receive", data: serializeMessage(ok), from: server }, 10)
    expect(events(outputs)).toEqual([{ type: "registration", state: "registered", expires: 600 }])
  })

  it("still wants an IP address as the source over UDP", () => {
    const udp = createCore({
      address: { transport: "UDP", host: "192.0.2.10", port: 5060 },
      aor: "sip:alice@example.com",
      random: createRandom(1),
    })
    const from = { transport: "UDP", host: "pbx.example.com", port: 5060 } as const
    expect(() => udp.handle({ type: "receive", data: bytes("x"), from }, 0)).toThrow(
      new TypeError('The source must be an IP address, got "pbx.example.com"'),
    )
  })

  it("adds no received for a source known by name", () => {
    const options = [
      "OPTIONS sip:alice@a1b2c3d4e5f6.invalid;transport=ws SIP/2.0",
      "Via: SIP/2.0/WSS proxy.example.com;branch=z9hG4bKprobe1;rport",
      "From: <sip:pbx.example.com>;tag=p1",
      "To: <sip:alice@example.com>",
      "Call-ID: probe-1",
      "CSeq: 1 OPTIONS",
      "Max-Forwards: 70",
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n")
    const [reply = ""] = texts(
      core().handle({ type: "receive", data: bytes(options), from: server }, 0),
    )
    expect(reply).toMatch(/^SIP\/2\.0 200 OK\r$/m)
    expect(reply).toMatch(/^Via: SIP\/2\.0\/WSS proxy\.example\.com;branch=z9hG4bKprobe1;rport\r$/m)
  })

  it("calls with ;ob in the Contact, without the registration's outbound parameters", () => {
    const outputs = core().handle(
      {
        type: "command",
        command: {
          type: "call",
          call: "call-1",
          uri: "sip:bob@example.com",
          to: server,
          media: aliceMedia,
        },
      },
      0,
    )
    const [text = ""] = texts(outputs)
    expect(text).toMatch(/^INVITE sip:bob@example\.com SIP\/2\.0\r$/m)
    expect(text).toMatch(/^Via: SIP\/2\.0\/WSS a1b2c3d4e5f6\.invalid;branch=/m)
    expect(text).toMatch(/^Contact: <sip:alice@a1b2c3d4e5f6\.invalid;transport=ws;ob>\r$/m)
  })

  it("registers with the instance it was given, and refuses one that is no UUID URN", () => {
    const instance = "urn:uuid:3f1c2e4d-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
    const given = createCore({
      address: local,
      aor: "sip:alice@example.com",
      random: createRandom(1),
      instance,
    })
    const [text = ""] = texts(given.handle(registerCommand, 0))
    expect(text).toContain(`+sip.instance="<${instance}>"`)
    expect(() =>
      createCore({
        address: local,
        aor: "sip:alice@example.com",
        random: createRandom(1),
        instance: "x",
      }),
    ).toThrow(new TypeError('instance must be a urn:uuid: URN, got "x"'))
  })

  it("replays a recording of a core that was given its instance", () => {
    const instance = "urn:uuid:3f1c2e4d-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
    const recorded = createRecordedCore({
      address: local,
      aor: "sip:alice@example.com",
      random: createRandom(1),
      instance,
    })
    recorded.handle(registerCommand, 0)
    expect(replay(recorded.recording())).toMatchObject({ ok: true })
  })

  it("registers a sips: Contact over wss:// for a sips: address of record", () => {
    const phone = createCore({
      address: local,
      aor: "sips:alice@example.com",
      random: createRandom(1),
    })
    const [text = ""] = texts(phone.handle(registerCommand, 0))
    expect(text).toMatch(/^Contact: <sips:alice@a1b2c3d4e5f6\.invalid;transport=ws>;reg-id=1;/m)
  })

  it("registers again at once on a new connection, without waiting for the old REGISTER", () => {
    const phone = core()
    expect(texts(phone.handle(registerCommand, 0))).toHaveLength(1)
    phone.handle({ type: "command", command: { type: "move", address: local } }, 10)
    const again = texts(phone.handle(registerCommand, 20))
    expect(again).toHaveLength(1)
    expect(again[0]).toMatch(/^CSeq: 2 REGISTER\r$/m)
  })

  it("registers without outbound once an edge answers 439", () => {
    const phone = core()
    const first = request(phone.handle(registerCommand, 0))
    const refused = createResponse(first, 439, "First Hop Lacks Outbound Support", { toTag: "r1" })
    const [retry = ""] = texts(
      phone.handle({ type: "receive", data: serializeMessage(refused), from: server }, 10),
    )
    expect(retry).toMatch(/^Contact: <sip:alice@a1b2c3d4e5f6\.invalid;transport=ws>\r$/m)
    expect(retry).toMatch(/^Supported: path\r$/m)
    const again = request([{ type: "send", data: bytes(retry), to: server }])
    const twice = createResponse(again, 439, "First Hop Lacks Outbound Support", { toTag: "r1" })
    const outputs = phone.handle(
      { type: "receive", data: serializeMessage(twice), from: server },
      20,
    )
    expect(events(outputs)).toEqual([
      {
        type: "registration",
        state: "failed",
        failure: { reason: "rejected", status: 439, phrase: "First Hop Lacks Outbound Support" },
      },
    ])
  })
})

describe("Straw calling Straw over WebSocket", () => {
  // The server sees the phone at the TCP source of its WebSocket
  const aliceAt: TransportAddress = { transport: "WSS", host: "198.51.100.7", port: 51_234 }
  const bobMedia = { host: "192.0.2.20", port: 4000 }

  function connected() {
    const cores = {
      alice: core(),
      bob: createCore({ address: server, aor: "sip:bob@example.com", random: createRandom(2) }),
    }
    const seen: Record<"alice" | "bob", CoreEvent[]> = { alice: [], bob: [] }
    const wire: string[] = []
    let now = 0
    function run(side: "alice" | "bob", input: CoreInput): void {
      const queue: ["alice" | "bob", CoreInput][] = [[side, input]]
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [who, step] = next
        for (const output of cores[who].handle(step, now++)) {
          if (output.type === "event") {
            seen[who].push(output.event)
            continue
          }
          const message = decoder.decode(output.data)
          wire.push(message)
          const to = who === "alice" ? "bob" : "alice"
          const from = who === "alice" ? aliceAt : server
          queue.push([to, { type: "receive", data: output.data, from }])
        }
      }
    }
    const call = (side: "alice" | "bob") => {
      const event = seen[side].find((entry) => entry.type === "call" && entry.state === "incoming")
      if (event?.type !== "call") throw new Error(`No incoming call for ${side}`)
      return event.call
    }
    const states = (side: "alice" | "bob") =>
      seen[side].flatMap((event) => (event.type === "call" ? [event.state] : []))
    return { run, wire, call, states }
  }

  it("carries a call out and its hangup back over the one connection", () => {
    const { run, wire, call, states } = connected()
    run("alice", {
      type: "command",
      command: {
        type: "call",
        call: "c1",
        uri: "sip:bob@example.com",
        to: server,
        media: aliceMedia,
      },
    })
    run("bob", { type: "command", command: { type: "accept", call: call("bob"), media: bobMedia } })
    run("alice", { type: "command", command: { type: "end", call: "c1" } })
    expect(wire.map((message) => message.slice(0, message.indexOf("\r\n")))).toEqual([
      "INVITE sip:bob@example.com SIP/2.0",
      "SIP/2.0 180 Ringing",
      "SIP/2.0 200 OK",
      "ACK sip:bob@pbx.example.com;transport=ws;ob SIP/2.0",
      "BYE sip:bob@pbx.example.com;transport=ws;ob SIP/2.0",
      "SIP/2.0 200 OK",
    ])
    expect(states("alice")).toEqual(["ringing", "live", "ended"])
    expect(states("bob")).toEqual(["incoming", "live", "ended"])
  })

  it("rings, answers and hangs up a call that comes in, with ;ob and without received", () => {
    const { run, wire, call, states } = connected()
    run("bob", {
      type: "command",
      command: {
        type: "call",
        call: "c2",
        uri: "sip:alice@example.com",
        to: aliceAt,
        media: bobMedia,
      },
    })
    run("alice", {
      type: "command",
      command: { type: "accept", call: call("alice"), media: aliceMedia },
    })
    run("bob", { type: "command", command: { type: "end", call: "c2" } })
    const answers = wire.filter(
      (message) => /^SIP\/2\.0 [12]/.test(message) && /^CSeq: \d+ INVITE\r$/m.test(message),
    )
    for (const answer of answers) {
      expect(answer).toMatch(/^Contact: <sip:alice@a1b2c3d4e5f6\.invalid;transport=ws;ob>\r$/m)
      expect(answer).not.toMatch(/received=/)
    }
    expect(answers.length).toBeGreaterThan(1)
    expect(states("alice")).toEqual(["incoming", "live", "ended"])
    expect(states("bob")).toEqual(["ringing", "live", "ended"])
  })
})
