import { describe, expect, it } from "vitest"
import { createTransactions } from "../../src/transaction/transactions"
import type { TransactionOutput } from "../../src/transaction/types"
import { alice, bob, parsed } from "../helpers"
import { kinds, request, response, udp } from "./support"

function serverKey(outputs: TransactionOutput[]): string {
  const created = outputs.find((output) => output.type === "event")
  if (created?.type !== "event" || created.event.type !== "request") throw new Error("No request")
  if (created.event.transaction === undefined) throw new Error("No transaction")
  return created.event.transaction
}

describe("createTransactions", () => {
  it("rejects invalid timer settings", () => {
    const timers = { t1: 500, t2: 100, t4: 0, d: 32_000, trying: 0 }
    expect(() => createTransactions({ local: alice, timers })).toThrow(
      "T2 must be at least T1 (500), got 100",
    )
  })

  it("schedules a transaction once per deadline however often it is touched", () => {
    const transactions = createTransactions({ local: alice })
    const key = serverKey(transactions.receive(request("OPTIONS"), bob, 0))
    transactions.respond(key, response(request("OPTIONS"), 200), 0)
    for (let at = 1; at <= 50; at++) transactions.receive(request("OPTIONS"), bob, at)
    expect(transactions.expire(32_000)).toEqual([])
    expect(transactions.nextDeadline()).toBeUndefined()
  })

  it("skips stale schedule entries of finished or rescheduled transactions", () => {
    const transactions = createTransactions({ local: alice })
    const options = request("OPTIONS")
    transactions.send(options, udp, 0)
    transactions.receive(response(options, 100), bob, 10)
    transactions.receive(response(options, 200), bob, 20)
    expect(transactions.nextDeadline()).toBe(5020)
    expect(transactions.expire(5020)).toEqual([])
    expect(transactions.nextDeadline()).toBeUndefined()
  })

  it("expires many transactions in deadline order", () => {
    const transactions = createTransactions({ local: alice })
    for (let index = 0; index < 1000; index++) {
      transactions.send(request("OPTIONS", `z9hG4bK${index}`), udp, index)
    }
    expect(transactions.nextDeadline()).toBe(500)
    expect(kinds(transactions.expire(600))).toHaveLength(101)
    expect(transactions.nextDeadline()).toBe(601)
  })

  describe("client side", () => {
    it("starts a client transaction per request and routes its responses", () => {
      const transactions = createTransactions({ local: alice })
      const options = request("OPTIONS")
      expect(kinds(transactions.send(options, udp, 0))).toEqual(["OPTIONS"])
      expect(transactions.nextDeadline()).toBe(500)
      expect(kinds(transactions.receive(response(options, 200), bob, 10))).toEqual(["response"])
    })

    it("picks the INVITE machine for INVITE requests", () => {
      const transactions = createTransactions({ local: alice })
      const invite = request("INVITE", "z9hG4bKinvite")
      transactions.send(invite, udp, 0)
      expect(kinds(transactions.receive(response(invite, 486), bob, 10))).toEqual([
        "ACK",
        "response",
      ])
    })

    it("refuses two transactions with the same branch and method", () => {
      const transactions = createTransactions({ local: alice })
      transactions.send(request("OPTIONS"), udp, 0)
      expect(() => transactions.send(request("OPTIONS"), udp, 1)).toThrow(
        "Transaction z9hG4bKclient|OPTIONS already exists",
      )
    })

    it("sends an ACK without a transaction", () => {
      const transactions = createTransactions({ local: alice })
      expect(kinds(transactions.send(request("ACK"), udp, 0))).toEqual(["ACK"])
      expect(transactions.nextDeadline()).toBeUndefined()
    })

    it("reports responses not addressed to our sent-by as stray (RFC 3261 §18.1.2)", () => {
      const transactions = createTransactions({ local: { ...alice, port: 5070 } })
      const options = request("OPTIONS")
      transactions.send(options, udp, 0)
      expect(transactions.receive(response(options, 200), bob, 10)).toMatchObject([
        { type: "event", event: { type: "stray" } },
      ])
    })

    it("reports responses without a transaction as stray", () => {
      const transactions = createTransactions({ local: alice })
      expect(transactions.receive(response(request("OPTIONS"), 200), bob, 0)).toMatchObject([
        { type: "event", event: { type: "stray" } },
      ])
    })

    it("forgets finished transactions so the branch can be reused", () => {
      const transactions = createTransactions({ local: alice })
      const options = request("OPTIONS")
      transactions.send(options, udp, 0)
      transactions.receive(response(options, 200), bob, 10)
      expect(transactions.expire(5010)).toEqual([])
      expect(transactions.nextDeadline()).toBeUndefined()
      expect(() => transactions.send(options, udp, 6000)).not.toThrow()
    })
  })

  describe("server side", () => {
    it("opens a server transaction and hands its key to the application", () => {
      const transactions = createTransactions({ local: alice })
      const outputs = transactions.receive(request("OPTIONS"), bob, 0)
      expect(outputs).toEqual([
        {
          type: "event",
          event: {
            type: "request",
            request: request("OPTIONS"),
            from: bob,
            transaction: "z9hG4bKclient|192.0.2.10:5060|OPTIONS",
          },
        },
      ])
    })

    it("hands an INVITE to the application and sends 100 Trying only if it stays silent", () => {
      const transactions = createTransactions({ local: alice })
      expect(kinds(transactions.receive(request("INVITE"), bob, 0))).toEqual(["request"])
      expect(transactions.nextDeadline()).toBe(200)
      expect(kinds(transactions.expire(200))).toEqual(["100"])
    })

    it("drops the 100 Trying alarm once the application answered provisionally", () => {
      const transactions = createTransactions({ local: alice })
      const key = serverKey(transactions.receive(request("INVITE"), bob, 0))
      transactions.respond(key, response(request("INVITE"), 180), 50)
      expect(transactions.expire(200)).toEqual([])
      expect(transactions.nextDeadline()).toBeUndefined()
    })

    it("resends cached responses to the source of a retransmission", () => {
      const transactions = createTransactions({ local: alice })
      const key = serverKey(transactions.receive(request("OPTIONS"), bob, 0))
      transactions.respond(key, response(request("OPTIONS"), 200), 0)
      const moved = { ...bob, port: 40_000 }
      expect(transactions.receive(request("OPTIONS"), moved, 500)).toMatchObject([
        { type: "send", to: moved },
      ])
    })

    it("absorbs retransmitted requests in the existing transaction", () => {
      const transactions = createTransactions({ local: alice })
      const key = serverKey(transactions.receive(request("OPTIONS"), bob, 0))
      transactions.respond(key, response(request("OPTIONS"), 200), 10)
      expect(kinds(transactions.receive(request("OPTIONS"), bob, 500))).toEqual(["200"])
    })

    it("replies to the address from Via and rport", () => {
      const transactions = createTransactions({ local: alice })
      const source = { ...bob, port: 40_000 }
      const key = serverKey(transactions.receive(request("OPTIONS"), source, 0))
      expect(transactions.respond(key, response(request("OPTIONS"), 200), 0)).toMatchObject([
        { type: "send", to: source },
      ])
    })

    it("rejects responses for unknown transactions", () => {
      expect(() =>
        createTransactions({ local: alice }).respond("nope", response(request(), 200), 0),
      ).toThrow("Unknown server transaction nope")
    })

    it("absorbs the ACK for a failure inside the INVITE transaction", () => {
      const transactions = createTransactions({ local: alice })
      const key = serverKey(transactions.receive(request("INVITE"), bob, 0))
      transactions.respond(key, response(request("INVITE"), 486), 0)
      expect(transactions.receive(request("ACK"), bob, 100)).toEqual([])
    })

    it("passes an ACK for a 2xx to the application", () => {
      const transactions = createTransactions({ local: alice })
      const key = serverKey(transactions.receive(request("INVITE"), bob, 0))
      transactions.respond(key, response(request("INVITE"), 200), 0)
      expect(transactions.receive(request("ACK"), bob, 100)).toMatchObject([
        { type: "event", event: { type: "request", request: { method: "ACK" } } },
      ])
      expect(transactions.receive(request("ACK", "z9hG4bKnew"), bob, 100)).toMatchObject([
        { type: "event", event: { type: "request" } },
      ])
    })

    it("confirms an RFC 2543 INVITE with an ACK that carries the new To tag", () => {
      const transactions = createTransactions({ local: alice })
      const legacy = request("INVITE", "legacy")
      const key = serverKey(transactions.receive(legacy, bob, 0))
      transactions.respond(key, response(legacy, 486, "b1"), 0)
      const ack = request("ACK", "legacy")
      const tagged = { ...ack, to: { ...ack.to, params: new Map([["tag", "b1"]]) } }
      expect(transactions.receive(tagged, bob, 100)).toEqual([])
      expect(kinds(transactions.expire(500))).toEqual([])
    })

    it("knows whether a CANCEL matches an INVITE transaction", () => {
      const transactions = createTransactions({ local: alice })
      expect(transactions.hasInvite(request("CANCEL", "z9hG4bKinvite"))).toBe(false)
      transactions.receive(request("INVITE", "z9hG4bKinvite"), bob, 0)
      expect(transactions.hasInvite(request("CANCEL", "z9hG4bKinvite"))).toBe(true)
    })

    it("forgets the INVITE once its transaction ended", () => {
      const transactions = createTransactions({ local: alice })
      const invite = request("INVITE", "z9hG4bKinvite")
      const key = serverKey(transactions.receive(invite, bob, 0))
      transactions.respond(key, response(invite, 486), 0)
      transactions.expire(32_000)
      expect(transactions.hasInvite(request("CANCEL", "z9hG4bKinvite"))).toBe(false)
    })

    it("treats a retransmission after Timer J as a new request", () => {
      const transactions = createTransactions({ local: alice })
      const key = serverKey(transactions.receive(request("OPTIONS"), bob, 0))
      transactions.respond(key, response(request("OPTIONS"), 200), 0)
      expect(transactions.expire(31_999)).toEqual([])
      expect(kinds(transactions.receive(request("OPTIONS"), bob, 31_999))).toEqual(["200"])
      expect(transactions.expire(32_000)).toEqual([])
      expect(serverKey(transactions.receive(request("OPTIONS"), bob, 32_001))).toBe(key)
    })

    it("matches RFC 2543 requests without the magic cookie", () => {
      const transactions = createTransactions({ local: alice })
      const legacy = parsed(
        [
          "OPTIONS sip:bob@example.com SIP/2.0",
          "Via: SIP/2.0/UDP 192.0.2.10:5060",
          "From: <sip:alice@example.com>",
          "To: <sip:bob@example.com>",
          "Call-ID: legacy",
          "CSeq: 1 OPTIONS",
          "",
          "",
        ].join("\r\n"),
      )
      const key = serverKey(transactions.receive(legacy, bob, 0))
      expect(key).toBe("rfc2543|legacy|||1|OPTIONS|192.0.2.10:5060|sip:bob@example.com")
      expect(transactions.receive(legacy, bob, 100)).toEqual([])
    })
  })

  it("expires due transactions of both kinds and keeps the others", () => {
    const transactions = createTransactions({ local: alice })
    transactions.receive(request("MESSAGE", "z9hG4bKidle"), bob, 0)
    transactions.send(request("OPTIONS"), udp, 0)
    const key = serverKey(transactions.receive(request("INVITE", "z9hG4bKin"), bob, 0))
    transactions.respond(key, response(request("INVITE", "z9hG4bKin"), 486), 0)
    expect(kinds(transactions.expire(500)).sort()).toEqual(["486", "OPTIONS"])
    expect(transactions.nextDeadline()).toBe(1500)
  })
})
