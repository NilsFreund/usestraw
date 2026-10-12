import { describe, expect, it } from "vitest"
import type { CallHandle } from "../../src/phone/call"
import { createInbox } from "../../src/phone/inbox"
import type { CallStatus } from "../../src/phone/types"

function ringing(id: string) {
  const call = { id, status: "ringing" as CallStatus }
  return { call, handle: { call } as unknown as CallHandle }
}

describe("phone.incoming", () => {
  it("forgets calls that stopped ringing before anyone read them", async () => {
    const incoming = createInbox()
    const first = ringing("first")
    incoming.push(first.handle)
    first.call.status = "ended"
    incoming.push(ringing("second").handle)
    first.call.status = "ringing"
    const iterator = incoming[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ value: { id: "second" } })
  })

  it("skips a call that was answered from phone.calls before anyone read it", async () => {
    const incoming = createInbox()
    const answered = ringing("answered")
    incoming.push(answered.handle)
    answered.call.status = "answering"
    const pending = incoming[Symbol.asyncIterator]().next()
    incoming.close()
    expect(await pending).toStrictEqual({ value: undefined, done: true })
  })
})
