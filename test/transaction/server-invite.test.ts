import { describe, expect, it } from "vitest"
import { createServerInvite } from "../../src/transaction/server-invite"
import { kinds, request, response, run, sends, tcp, udp } from "./support"

const invite = request("INVITE", "z9hG4bKinvite")
const plainAck = request("ACK", "z9hG4bKinvite")
const moved = { ...udp, port: 40_000 }

function ackWithTag(tag: string) {
  return { ...plainAck, to: { ...plainAck.to, params: new Map([["tag", tag]]) } }
}

const ack = ackWithTag("b1")

describe("createServerInvite (RFC 3261 §17.2.1, RFC 6026)", () => {
  it("sends 100 Trying after 200 ms when the application stays silent", () => {
    const transaction = createServerInvite(invite, udp)
    expect(transaction.start(0)).toEqual([])
    expect(transaction.state).toBe("proceeding")
    expect(transaction.key).toBe("z9hG4bKinvite|192.0.2.10:5060|INVITE")
    const [trying] = sends(transaction.expire(200))
    expect(trying && "status" in trying && trying.status).toBe(100)
    expect(trying?.to.params.has("tag")).toBe(false)
  })

  it("uses the configured 100 Trying delay", () => {
    const transaction = createServerInvite(invite, udp, {
      t1: 100,
      t2: 400,
      t4: 500,
      d: 6400,
      trying: 40,
    })
    transaction.start(0)
    expect(transaction.nextDeadline()).toBe(40)
  })

  it("copies Timestamp into 100 Trying with the delay in seconds (RFC 3261 §8.2.6.1)", () => {
    const stamped = request("INVITE", "z9hG4bKinvite", ["Timestamp: 54.3 0.1"])
    const transaction = createServerInvite(stamped, udp)
    transaction.start(1000)
    const [trying] = sends(transaction.expire(1200))
    expect(trying?.headers).toEqual([{ name: "Timestamp", value: "54.3 0.2" }])
  })

  it("measures the delay anew for each resent 100 Trying", () => {
    const stamped = request("INVITE", "z9hG4bKinvite", ["Timestamp: 54"])
    const transaction = createServerInvite(stamped, udp)
    transaction.start(0)
    expect(sends(transaction.receive(stamped, udp, 150))[0]?.headers).toEqual([
      { name: "Timestamp", value: "54 0.15" },
    ])
    expect(sends(transaction.receive(stamped, udp, 900))[0]?.headers).toEqual([
      { name: "Timestamp", value: "54 0.9" },
    ])
  })

  it("skips 100 Trying when the application answers within 200 ms", () => {
    const transaction = createServerInvite(invite, udp)
    transaction.start(0)
    expect(kinds(transaction.respond(response(invite, 180), 50))).toEqual(["180"])
    expect(transaction.expire(200)).toEqual([])
  })

  it("sends 100 Trying at once for a retransmitted INVITE and not again later", () => {
    const transaction = createServerInvite(invite, udp)
    transaction.start(0)
    expect(kinds(transaction.receive(invite, udp, 100))).toEqual(["100"])
    expect(transaction.expire(200)).toEqual([])
  })

  it("resends the latest provisional response to the latest source", () => {
    const transaction = createServerInvite(invite, udp)
    transaction.start(0)
    transaction.respond(response(invite, 180), 10)
    expect(transaction.receive(invite, moved, 300)).toMatchObject([
      { type: "send", message: { status: 180 }, to: moved },
    ])
  })

  it("retransmits a failure with Timer G until Timer H reports it unacknowledged", () => {
    const transaction = createServerInvite(invite, udp)
    transaction.start(0)
    expect(kinds(transaction.respond(response(invite, 486), 0))).toEqual(["486"])
    expect(transaction.state).toBe("completed")
    expect(kinds(transaction.receive(invite, udp, 100))).toEqual(["486"])
    expect(run(transaction)).toEqual([
      [500, ["486"]],
      [1500, ["486"]],
      [3500, ["486"]],
      [7500, ["486"]],
      [11500, ["486"]],
      [15500, ["486"]],
      [19500, ["486"]],
      [23500, ["486"]],
      [27500, ["486"]],
      [31500, ["486"]],
      [32000, ["unacknowledged"]],
    ])
    expect(transaction.state).toBe("terminated")
  })

  it("retransmits the failure to the latest source", () => {
    const transaction = createServerInvite(invite, udp)
    transaction.start(0)
    transaction.respond(response(invite, 486), 0)
    transaction.receive(invite, moved, 100)
    expect(transaction.expire(500)).toMatchObject([{ type: "send", to: moved }])
  })

  it("confirms on a matching ACK, absorbs further ACKs and ends after Timer I", () => {
    const transaction = createServerInvite(invite, udp)
    transaction.start(0)
    transaction.respond(response(invite, 486), 0)
    expect(transaction.receive(ack, udp, 700)).toEqual([])
    expect(transaction.state).toBe("confirmed")
    expect(transaction.receive(ack, udp, 800)).toEqual([])
    expect(transaction.receive(invite, udp, 900)).toEqual([])
    expect(run(transaction)).toEqual([[5700, []]])
    expect(transaction.state).toBe("terminated")
  })

  it("ignores an RFC 2543 ACK whose To tag does not match the response", () => {
    const legacy = request("INVITE", "legacy")
    const transaction = createServerInvite(legacy, udp)
    transaction.start(0)
    transaction.respond(response(legacy, 486), 0)
    const legacyAck = request("ACK", "legacy")
    const tagged = (tag: string) => ({
      ...legacyAck,
      to: { ...legacyAck.to, params: new Map([["tag", tag]]) },
    })
    expect(transaction.receive(tagged("other"), udp, 700)).toEqual([])
    expect(transaction.state).toBe("completed")
    transaction.receive(tagged("b1"), udp, 800)
    expect(transaction.state).toBe("confirmed")
  })

  it("accepts a magic-cookie ACK regardless of its To tag", () => {
    const transaction = createServerInvite(invite, udp)
    transaction.start(0)
    transaction.respond(response(invite, 486), 0)
    transaction.receive(ackWithTag("whatever"), udp, 700)
    expect(transaction.state).toBe("confirmed")
  })

  it("ignores an ACK before the final response", () => {
    const transaction = createServerInvite(invite, udp)
    transaction.start(0)
    expect(transaction.receive(ack, udp, 10)).toEqual([])
    expect(transaction.state).toBe("proceeding")
  })

  it("accepts with 2xx, lets the user resend only 2xx and absorbs INVITEs until Timer L", () => {
    const transaction = createServerInvite(invite, udp)
    transaction.start(0)
    expect(kinds(transaction.respond(response(invite, 200), 0))).toEqual(["200"])
    expect(transaction.state).toBe("accepted")
    expect(kinds(transaction.respond(response(invite, 200), 500))).toEqual(["200"])
    expect(transaction.respond(response(invite, 180), 550)).toEqual([])
    expect(transaction.respond(response(invite, 486), 600)).toEqual([])
    expect(transaction.receive(invite, udp, 700)).toEqual([])
    expect(run(transaction)).toEqual([[32_000, []]])
  })

  it("sends later 2xx retransmissions to the source of the latest INVITE", () => {
    const transaction = createServerInvite(invite, udp)
    transaction.start(0)
    transaction.respond(response(invite, 200), 0)
    expect(transaction.receive(invite, moved, 300)).toEqual([])
    expect(transaction.respond(response(invite, 200), 500)).toMatchObject([
      { type: "send", message: { status: 200 }, to: moved },
    ])
  })

  it("treats 299 as success and 300 as failure", () => {
    const success = createServerInvite(invite, udp)
    success.start(0)
    success.respond(response(invite, 299), 0)
    expect(success.state).toBe("accepted")
    const failure = createServerInvite(invite, udp)
    failure.start(0)
    failure.respond(response(invite, 300), 0)
    expect(failure.state).toBe("completed")
  })

  it("ignores retransmissions once terminated", () => {
    const transaction = createServerInvite(invite, tcp)
    transaction.start(0)
    transaction.respond(response(invite, 486), 0)
    transaction.receive(ack, tcp, 10)
    expect(transaction.state).toBe("terminated")
    expect(transaction.receive(invite, tcp, 20)).toEqual([])
  })

  it("ignores retransmissions once confirmed", () => {
    const transaction = createServerInvite(invite, udp)
    transaction.start(0)
    transaction.respond(response(invite, 486), 0)
    transaction.receive(ack, udp, 100)
    expect(transaction.receive(invite, moved, 200)).toEqual([])
    expect(transaction.expire(500)).toEqual([])
  })

  it("ignores responses after the transaction completed", () => {
    const transaction = createServerInvite(invite, udp)
    transaction.start(0)
    transaction.respond(response(invite, 486), 0)
    expect(transaction.respond(response(invite, 200), 10)).toEqual([])
  })

  it("does not retransmit and ends on ACK right away on reliable transports", () => {
    const transaction = createServerInvite(invite, tcp)
    transaction.start(0)
    transaction.respond(response(invite, 486), 0)
    expect(transaction.nextDeadline()).toBe(32_000)
    transaction.receive(ack, tcp, 10)
    expect(transaction.state).toBe("terminated")
  })

  it("reports the missing ACK instead of retransmitting when both fall due together", () => {
    const transaction = createServerInvite(invite, udp)
    transaction.start(0)
    transaction.respond(response(invite, 486), 0)
    run(transaction, 31_500)
    expect(kinds(transaction.expire(40_000))).toEqual(["unacknowledged"])
  })
})
