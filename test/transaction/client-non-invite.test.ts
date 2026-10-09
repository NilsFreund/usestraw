import { describe, expect, it } from "vitest"
import { createClientNonInvite } from "../../src/transaction/client-non-invite"
import { bob } from "../helpers"
import { kinds, request, response, run, tcp, udp } from "./support"

const options = request("OPTIONS")

describe("createClientNonInvite (RFC 3261 §17.1.2)", () => {
  it("sends the request and starts in Trying", () => {
    const transaction = createClientNonInvite(options, udp)
    expect(transaction.start(0)).toEqual([{ type: "send", message: options, to: udp }])
    expect(transaction.state).toBe("trying")
    expect(transaction.key).toBe("z9hG4bKclient|OPTIONS")
    expect(transaction.nextDeadline()).toBe(500)
  })

  it("retransmits with Timer E doubling up to T2 and times out with Timer F", () => {
    const transaction = createClientNonInvite(options, udp)
    transaction.start(0)
    expect(run(transaction)).toEqual([
      [500, ["OPTIONS"]],
      [1500, ["OPTIONS"]],
      [3500, ["OPTIONS"]],
      [7500, ["OPTIONS"]],
      [11500, ["OPTIONS"]],
      [15500, ["OPTIONS"]],
      [19500, ["OPTIONS"]],
      [23500, ["OPTIONS"]],
      [27500, ["OPTIONS"]],
      [31500, ["OPTIONS"]],
      [32000, ["timeout"]],
    ])
    expect(transaction.state).toBe("terminated")
  })

  it("retransmits every T2 after a provisional response", () => {
    const transaction = createClientNonInvite(options, udp)
    transaction.start(0)
    run(transaction, 500)
    expect(kinds(transaction.receive(response(options, 100), bob, 600))).toEqual(["response"])
    expect(transaction.state).toBe("proceeding")
    expect(run(transaction, 10_000)).toEqual([
      [1500, ["OPTIONS"]],
      [5500, ["OPTIONS"]],
      [9500, ["OPTIONS"]],
    ])
  })

  it("completes on a final response, absorbs repeats and ends after Timer K", () => {
    const transaction = createClientNonInvite(options, udp)
    transaction.start(0)
    expect(kinds(transaction.receive(response(options, 200), bob, 40))).toEqual(["response"])
    expect(transaction.state).toBe("completed")
    expect(transaction.receive(response(options, 200), bob, 60)).toEqual([])
    expect(transaction.receive(response(options, 100), bob, 70)).toEqual([])
    expect(run(transaction)).toEqual([[5040, []]])
    expect(transaction.state).toBe("terminated")
    expect(transaction.receive(response(options, 200), bob, 6000)).toEqual([])
  })

  it("completes from Proceeding as well", () => {
    const transaction = createClientNonInvite(options, udp)
    transaction.start(0)
    transaction.receive(response(options, 180), bob, 10)
    transaction.receive(response(options, 404), bob, 20)
    expect(transaction.state).toBe("completed")
  })

  it("neither retransmits nor waits for Timer K on reliable transports", () => {
    const transaction = createClientNonInvite(options, tcp)
    transaction.start(0)
    expect(transaction.nextDeadline()).toBe(32_000)
    transaction.receive(response(options, 200), bob, 10)
    expect(transaction.state).toBe("terminated")
    expect(transaction.nextDeadline()).toBeUndefined()
  })

  it("stops at Timer F even when a later retransmission is overdue too", () => {
    const transaction = createClientNonInvite(options, udp)
    transaction.start(0)
    run(transaction, 31_000)
    transaction.receive(response(options, 100), bob, 31_100)
    run(transaction, 31_500)
    expect(kinds(transaction.expire(40_000))).toEqual(["timeout"])
  })

  it("times out instead of retransmitting when both fall due together", () => {
    const transaction = createClientNonInvite(options, udp, {
      t1: 100,
      t2: 100,
      t4: 0,
      d: 6400,
      trying: 0,
    })
    transaction.start(0)
    run(transaction, 6300)
    expect(kinds(transaction.expire(6400))).toEqual(["timeout"])
  })

  it("does nothing when no timer is due", () => {
    const transaction = createClientNonInvite(options, udp)
    transaction.start(0)
    expect(transaction.expire(100)).toEqual([])
  })

  it("uses custom timer settings", () => {
    const transaction = createClientNonInvite(options, udp, {
      t1: 100,
      t2: 300,
      t4: 1000,
      d: 6400,
      trying: 0,
    })
    transaction.start(0)
    expect(run(transaction).map(([at]) => at)).toEqual([
      100, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000, 3300, 3600, 3900, 4200, 4500,
      4800, 5100, 5400, 5700, 6000, 6300, 6400,
    ])
  })
})
