import { describe, expect, it } from "vitest"
import { serializeMessage } from "../../src"
import { event, send } from "../../src/core/outputs"
import { bob, parsedRequest, register } from "../helpers"

describe("outputs", () => {
  it("serializes messages to send", () => {
    const request = parsedRequest(register)
    expect(send(request, bob)).toStrictEqual({
      type: "send",
      data: serializeMessage(request),
      to: bob,
    })
  })

  it("wraps events", () => {
    const happened = { type: "registration", state: "unregistered" } as const
    expect(event(happened)).toStrictEqual({ type: "event", event: happened })
  })
})
