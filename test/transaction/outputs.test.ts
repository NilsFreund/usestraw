import { describe, expect, it } from "vitest"
import { notify, send } from "../../src/transaction/outputs"
import { request, udp } from "./support"

describe("outputs", () => {
  it("wraps messages to send", () => {
    const options = request()
    expect(send(options, udp)).toEqual({ type: "send", message: options, to: udp })
  })

  it("wraps events", () => {
    const event = { type: "timeout", request: request() } as const
    expect(notify(event)).toEqual({ type: "event", event })
  })
})
