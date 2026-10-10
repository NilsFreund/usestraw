import { describe, expect, it } from "vitest"
import type { CallHandle, CallStatus } from "../../src/node/calls"
import { createIncoming } from "../../src/node/incoming"

function ringing(id: string) {
  const call = { id, status: "ringing" as CallStatus }
  return { call, handle: { call } as unknown as CallHandle }
}

describe("phone.incoming", () => {
  it("forgets calls that stopped ringing before anyone read them", async () => {
    const incoming = createIncoming()
    const first = ringing("first")
    incoming.push(first.handle)
    first.call.status = "ended"
    incoming.push(ringing("second").handle)
    first.call.status = "ringing"
    const iterator = incoming[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ value: { id: "second" } })
  })
})
