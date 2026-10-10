import { describe, expect, it } from "vitest"
import { type CallEnd, type CoreEvent, createCore, type Random, replay } from "../../src"
import { createRecordedCore, type RecordedCore } from "../../src/recorder/recorder"
import { type LinkConditions, latency, loss } from "../../src/simulation/network/conditions"
import { createSimulation } from "../../src/simulation/simulation"
import { formatTrace } from "../../src/simulation/trace"
import { type AnswererOptions, answerer } from "../answerer"
import { alice, bob } from "../helpers"

const media = { host: "192.0.2.20", port: 4000 } as const
const lossy: LinkConditions = {
  latency: latency.uniform(10, 80),
  loss: loss.random(0.3),
  duplicate: 0.1,
}

function setup(
  options: AnswererOptions,
  internet: LinkConditions = { latency: latency.fixed(20) },
  seed = 1,
) {
  const simulation = createSimulation({ seed, internet })
  const phone = simulation.addNode("phone", alice, (random: Random) =>
    answerer(createCore({ address: alice, aor: "sip:alice@example.com", random }), options),
  )
  const caller = simulation.addNode("caller", bob, (random: Random) =>
    createCore({ address: bob, aor: "sip:bob@example.com", random }),
  )
  const dial = () =>
    simulation.command(caller, {
      type: "call",
      call: "c1",
      uri: "sip:alice@192.0.2.10",
      to: alice,
      media,
    })
  const end = (at: number) =>
    simulation.at(at, () => simulation.command(caller, { type: "end", call: "c1" }))
  return { simulation, phone, caller, dial, end }
}

function states(events: readonly CoreEvent[]): string[] {
  return events.flatMap((event) => (event.type === "call" ? [event.state] : []))
}

function ended(events: readonly CoreEvent[]): CallEnd | undefined {
  for (const event of events)
    if (event.type === "call" && event.state === "ended") return event.ended
  return undefined
}

describe("incoming calls from another Straw phone", () => {
  it("rings, gets answered and ends when the caller hangs up", () => {
    const { simulation, phone, caller, dial, end } = setup({ answerAfter: 2000 })
    dial()
    end(5000)
    simulation.run(10_000)
    expect(formatTrace(simulation.trace)).toBe(
      [
        "     0ms  caller → phone  INVITE sip:alice@192.0.2.10 SIP/2.0  (+20ms)",
        "    20ms  phone → caller  SIP/2.0 180 Ringing  (+20ms)",
        "  2020ms  phone → caller  SIP/2.0 200 OK  (+20ms)",
        "  2040ms  caller → phone  ACK sip:alice@192.0.2.10:5060 SIP/2.0  (+20ms)",
        "  5000ms  caller → phone  BYE sip:alice@192.0.2.10:5060 SIP/2.0  (+20ms)",
        "  5020ms  phone → caller  SIP/2.0 200 OK  (+20ms)",
      ].join("\n"),
    )
    expect(states(phone.events)).toStrictEqual(["incoming", "live", "ended"])
    expect(states(caller.events)).toStrictEqual(["ringing", "live", "ended"])
    expect(ended(phone.events)).toStrictEqual({ by: "remote", reason: "hangup" })
    expect(ended(caller.events)).toStrictEqual({ by: "local", reason: "hangup" })
    const agreed = { codec: "PCMU", payloadType: 0, dtmf: 101, ptime: 20, direction: "sendrecv" }
    expect(phone.events).toContainEqual({
      type: "call",
      call: "c1",
      state: "live",
      media: { remote: { host: "192.0.2.20", port: 4000 }, ...agreed },
    })
    expect(caller.events).toContainEqual({
      type: "call",
      call: "c1",
      state: "live",
      media: { remote: { host: "192.0.2.10", port: 40_000 }, ...agreed },
    })
  })

  it("hangs up on its own and the caller follows", () => {
    const { simulation, phone, caller, dial } = setup({ answerAfter: 1000, hangupAfter: 3000 })
    dial()
    simulation.run(10_000)
    expect(ended(phone.events)).toStrictEqual({ by: "local", reason: "hangup" })
    expect(ended(caller.events)).toStrictEqual({ by: "remote", reason: "hangup" })
  })

  it("stops ringing when the caller cancels", () => {
    const { simulation, phone, caller, dial, end } = setup({})
    dial()
    end(3000)
    simulation.run(10_000)
    expect(states(phone.events)).toStrictEqual(["incoming", "ended"])
    expect(ended(phone.events)).toStrictEqual({ by: "remote", reason: "cancelled" })
    expect(ended(caller.events)).toStrictEqual({ by: "local", reason: "cancelled" })
  })

  it("rejects the call and the caller learns why", () => {
    const { simulation, phone, caller, dial } = setup({ answerAfter: 1000, reject: 603 })
    dial()
    simulation.run(10_000)
    expect(ended(phone.events)).toStrictEqual({ by: "local", reason: "declined", status: 603 })
    expect(ended(caller.events)).toStrictEqual({ by: "remote", reason: "declined", status: 603 })
  })

  it("records an incoming call that replays byte for byte", () => {
    const simulation = createSimulation({ seed: 5, internet: lossy })
    let recorded: RecordedCore | undefined
    simulation.addNode("phone", alice, (random) => {
      recorded = createRecordedCore({ address: alice, aor: "sip:alice@example.com", random })
      return answerer(recorded, { answerAfter: 1500, hangupAfter: 3000 })
    })
    const caller = simulation.addNode("caller", bob, (random) =>
      createCore({ address: bob, aor: "sip:bob@example.com", random }),
    )
    simulation.command(caller, {
      type: "call",
      call: "c1",
      uri: "sip:alice@192.0.2.10",
      to: alice,
      media,
    })
    simulation.run(60_000)
    expect(states(caller.events)).toContain("ended")
    expect(replay(recorded?.recording() ?? "")).toMatchObject({ ok: true })
  })
})

describe("incoming calls through 30 % loss and duplicates", () => {
  const seeds = Array.from({ length: 60 }, (_, index) => index + 1)

  function settle(simulation: ReturnType<typeof setup>["simulation"], seed: number) {
    simulation.run(200_000)
    return `seed ${seed}\n${formatTrace(simulation.trace)}`
  }

  it("connects and ends when the caller hangs up in every seed", () => {
    for (const seed of seeds) {
      const { simulation, phone, caller, dial, end } = setup({ answerAfter: 2000 }, lossy, seed)
      dial()
      end(10_000)
      const trace = settle(simulation, seed)
      expect(states(phone.events), trace).toStrictEqual(["incoming", "live", "ended"])
      const heard = states(caller.events).filter((state) => state !== "ringing")
      expect(heard, trace).toStrictEqual(["live", "ended"])
      expect(ended(phone.events), trace).toStrictEqual({ by: "remote", reason: "hangup" })
      expect(phone.core.nextDeadline(), trace).toBeUndefined()
      expect(caller.core.nextDeadline(), trace).toBeUndefined()
    }
  })

  it("connects and ends when it hangs up itself in every seed", () => {
    for (const seed of seeds) {
      const options = { answerAfter: 2000, hangupAfter: 5000 }
      const { simulation, phone, caller, dial } = setup(options, lossy, seed)
      dial()
      const trace = settle(simulation, seed)
      expect(ended(phone.events), trace).toStrictEqual({ by: "local", reason: "hangup" })
      expect(ended(caller.events), trace).toStrictEqual({ by: "remote", reason: "hangup" })
      expect(phone.core.nextDeadline(), trace).toBeUndefined()
    }
  })

  it("stops ringing when the caller cancels in every seed", () => {
    for (const seed of seeds) {
      const { simulation, phone, caller, dial, end } = setup({}, lossy, seed)
      dial()
      end(3000)
      const trace = settle(simulation, seed)
      expect(ended(phone.events), trace).toStrictEqual({ by: "remote", reason: "cancelled" })
      expect(ended(caller.events), trace).toStrictEqual({ by: "local", reason: "cancelled" })
      expect(phone.core.nextDeadline(), trace).toBeUndefined()
    }
  })

  it("hangs up right after answering, waiting for the ACK first, in every seed", () => {
    for (const seed of seeds) {
      const options = { answerAfter: 1000, hangupAfter: 0 }
      const { simulation, phone, caller, dial } = setup(options, lossy, seed)
      dial()
      const trace = settle(simulation, seed)
      expect(ended(phone.events), trace).toStrictEqual({ by: "local", reason: "hangup" })
      expect(ended(caller.events), trace).toStrictEqual({ by: "remote", reason: "hangup" })
      expect(phone.core.nextDeadline(), trace).toBeUndefined()
      expect(caller.core.nextDeadline(), trace).toBeUndefined()
    }
  })

  it("rejects the call and both sides learn it exactly once in every seed", () => {
    for (const seed of seeds) {
      const { simulation, phone, caller, dial } = setup({ reject: 486 }, lossy, seed)
      dial()
      const trace = settle(simulation, seed)
      expect(states(phone.events), trace).toStrictEqual(["incoming", "ended"])
      expect(ended(phone.events), trace).toStrictEqual({ by: "local", reason: "busy", status: 486 })
      expect(
        states(caller.events).filter((state) => state === "ended"),
        trace,
      ).toHaveLength(1)
      expect(ended(caller.events), trace).toStrictEqual({
        by: "remote",
        reason: "busy",
        status: 486,
      })
      expect(phone.core.nextDeadline(), trace).toBeUndefined()
    }
  })

  it("ends on both sides when the answer races the cancel in every seed", () => {
    for (const seed of seeds) {
      const { simulation, phone, caller, dial, end } = setup({ answerAfter: 3000 }, lossy, seed)
      dial()
      end(3000)
      const trace = settle(simulation, seed)
      expect(ended(caller.events), trace).toStrictEqual({ by: "local", reason: "cancelled" })
      expect(["cancelled", "hangup"], trace).toContain(ended(phone.events)?.reason)
      expect(ended(phone.events)?.by, trace).toBe("remote")
      expect(phone.core.nextDeadline(), trace).toBeUndefined()
      expect(caller.core.nextDeadline(), trace).toBeUndefined()
    }
  })
})
