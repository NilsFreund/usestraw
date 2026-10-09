import { describe, expect, it } from "vitest"
import { createServerNonInvite } from "../../src/transaction/server-non-invite"
import { kinds, request, response, run, tcp, udp } from "./support"

const options = request("OPTIONS")
const moved = { ...udp, port: 40_000 }

describe("createServerNonInvite (RFC 3261 §17.2.2)", () => {
  it("starts in Trying without sending anything and absorbs retransmissions", () => {
    const transaction = createServerNonInvite(options, udp)
    expect(transaction.start(0)).toEqual([])
    expect(transaction.state).toBe("trying")
    expect(transaction.key).toBe("z9hG4bKclient|192.0.2.10:5060|OPTIONS")
    expect(transaction.receive(options, udp, 100)).toEqual([])
  })

  it("resends the latest provisional response in Proceeding", () => {
    const transaction = createServerNonInvite(options, udp)
    expect(kinds(transaction.respond(response(options, 100), 0))).toEqual(["100"])
    expect(transaction.state).toBe("proceeding")
    expect(kinds(transaction.receive(options, udp, 500))).toEqual(["100"])
  })

  it("resends the final response until Timer J ends the transaction", () => {
    const transaction = createServerNonInvite(options, udp)
    expect(kinds(transaction.respond(response(options, 200), 0))).toEqual(["200"])
    expect(transaction.state).toBe("completed")
    expect(kinds(transaction.receive(options, udp, 500))).toEqual(["200"])
    expect(transaction.respond(response(options, 500), 600)).toEqual([])
    expect(run(transaction)).toEqual([[32_000, []]])
    expect(transaction.state).toBe("terminated")
    expect(transaction.receive(options, udp, 33_000)).toEqual([])
    expect(transaction.respond(response(options, 200), 33_000)).toEqual([])
  })

  it("resends to the source of the latest retransmission", () => {
    const transaction = createServerNonInvite(options, udp)
    transaction.respond(response(options, 200), 0)
    expect(transaction.receive(options, moved, 500)).toMatchObject([{ type: "send", to: moved }])
  })

  it("does nothing when no timer is due", () => {
    const transaction = createServerNonInvite(options, udp)
    transaction.respond(response(options, 200), 0)
    expect(transaction.expire(100)).toEqual([])
    expect(transaction.state).toBe("completed")
  })

  it("ends right after the final response on reliable transports", () => {
    const transaction = createServerNonInvite(options, tcp)
    transaction.respond(response(options, 200), 0)
    expect(transaction.state).toBe("terminated")
    expect(transaction.nextDeadline()).toBeUndefined()
  })
})
