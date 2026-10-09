import { describe, expect, it } from "vitest"
import { isRequest } from "../../src"
import { createClientInvite } from "../../src/transaction/client-invite"
import { bob } from "../helpers"
import { kinds, request, response, run, sends, tcp, udp } from "./support"

const invite = request("INVITE", "z9hG4bKinvite", ["Route: <sip:proxy.example.com;lr>"])

describe("createClientInvite (RFC 3261 §17.1.1, RFC 6026)", () => {
  it("sends the INVITE and starts in Calling", () => {
    const transaction = createClientInvite(invite, udp)
    expect(kinds(transaction.start(0))).toEqual(["INVITE"])
    expect(transaction.state).toBe("calling")
    expect(transaction.key).toBe("z9hG4bKinvite|INVITE")
  })

  it("retransmits with Timer A doubling and times out with Timer B", () => {
    const transaction = createClientInvite(invite, udp)
    transaction.start(0)
    expect(run(transaction)).toEqual([
      [500, ["INVITE"]],
      [1500, ["INVITE"]],
      [3500, ["INVITE"]],
      [7500, ["INVITE"]],
      [15500, ["INVITE"]],
      [31500, ["INVITE"]],
      [32000, ["timeout"]],
    ])
    expect(transaction.state).toBe("terminated")
  })

  it("stops retransmitting and waits for the user after a provisional response", () => {
    const transaction = createClientInvite(invite, udp)
    transaction.start(0)
    expect(kinds(transaction.receive(response(invite, 180), bob, 100))).toEqual(["response"])
    expect(transaction.state).toBe("proceeding")
    expect(transaction.nextDeadline()).toBeUndefined()
    expect(kinds(transaction.receive(response(invite, 183), bob, 200_000))).toEqual(["response"])
    expect(kinds(transaction.receive(response(invite, 200), bob, 400_000))).toEqual(["response"])
  })

  it("times out with Timer B at 64*T1 even when Timer D is longer", () => {
    const transaction = createClientInvite(invite, udp, {
      t1: 100,
      t2: 4000,
      t4: 5000,
      d: 32_000,
      trying: 200,
    })
    transaction.start(0)
    expect(run(transaction).at(-1)).toEqual([6400, ["timeout"]])
  })

  it("waits Timer D and not 64*T1 after a failure", () => {
    const transaction = createClientInvite(invite, udp, {
      t1: 100,
      t2: 4000,
      t4: 5000,
      d: 32_000,
      trying: 200,
    })
    transaction.start(0)
    transaction.receive(response(invite, 486), bob, 10)
    expect(run(transaction)).toEqual([[32_010, []]])
  })

  it("treats 299 as success and 300 as failure", () => {
    const success = createClientInvite(invite, udp)
    success.start(0)
    success.receive(response(invite, 299), bob, 0)
    expect(success.state).toBe("accepted")
    const failure = createClientInvite(invite, udp)
    failure.start(0)
    expect(kinds(failure.receive(response(invite, 300), bob, 0))).toEqual(["ACK", "response"])
    expect(failure.state).toBe("completed")
  })

  it("does nothing when no timer is due", () => {
    const transaction = createClientInvite(invite, udp)
    transaction.start(0)
    expect(transaction.expire(100)).toEqual([])
  })

  it("passes 2xx and its retransmissions on in Accepted until Timer M", () => {
    const transaction = createClientInvite(invite, udp)
    transaction.start(0)
    expect(kinds(transaction.receive(response(invite, 200), bob, 100))).toEqual(["response"])
    expect(transaction.state).toBe("accepted")
    expect(kinds(transaction.receive(response(invite, 200), bob, 600))).toEqual(["response"])
    expect(transaction.receive(response(invite, 486), bob, 700)).toEqual([])
    expect(transaction.receive(response(invite, 180), bob, 800)).toEqual([])
    expect(run(transaction)).toEqual([[32_100, []]])
    expect(transaction.state).toBe("terminated")
  })

  it("acknowledges failures itself and repeats the ACK for retransmissions", () => {
    const transaction = createClientInvite(invite, udp)
    transaction.start(0)
    const failure = response(invite, 486)
    const outputs = transaction.receive(failure, bob, 100)
    expect(kinds(outputs)).toEqual(["ACK", "response"])
    expect(transaction.state).toBe("completed")
    const [ack] = sends(outputs)
    expect(ack && isRequest(ack) && ack).toMatchObject({
      method: "ACK",
      uri: invite.uri,
      callId: invite.callId,
      cseq: { seq: 1, method: "ACK" },
      headers: [{ name: "Route", value: "<sip:proxy.example.com;lr>" }],
    })
    expect(ack?.to.params.get("tag")).toBe("b1")
    expect(ack?.via).toEqual(invite.via)
    expect(kinds(transaction.receive(failure, bob, 600))).toEqual(["ACK"])
    expect(transaction.receive(response(invite, 200), bob, 700)).toEqual([])
    expect(run(transaction)).toEqual([[32_100, []]])
  })

  it("acknowledges failures that follow a provisional response", () => {
    const transaction = createClientInvite(invite, udp)
    transaction.start(0)
    transaction.receive(response(invite, 180), bob, 50)
    expect(kinds(transaction.receive(response(invite, 603), bob, 100))).toEqual(["ACK", "response"])
  })

  it("neither retransmits nor waits for Timer D on reliable transports", () => {
    const transaction = createClientInvite(invite, tcp)
    transaction.start(0)
    expect(transaction.nextDeadline()).toBe(32_000)
    expect(kinds(transaction.receive(response(invite, 486), bob, 10))).toEqual(["ACK", "response"])
    expect(transaction.state).toBe("terminated")
  })

  it("ignores everything once terminated", () => {
    const transaction = createClientInvite(invite, tcp)
    transaction.start(0)
    transaction.receive(response(invite, 486), bob, 10)
    expect(transaction.receive(response(invite, 486), bob, 20)).toEqual([])
  })

  it("stops at Timer B even when a later retransmission is overdue too", () => {
    const transaction = createClientInvite(invite, udp)
    transaction.start(0)
    run(transaction, 31_500)
    expect(kinds(transaction.expire(70_000))).toEqual(["timeout"])
  })
})
