import { describe, expect, it } from "vitest"
import { createTrying } from "../../src/transaction/trying"
import { request } from "./support"

describe("createTrying", () => {
  it("creates a 100 Trying without To tag", () => {
    const trying = createTrying(request("INVITE"), 200)
    expect(trying).toMatchObject({ status: 100, reason: "Trying", headers: [] })
    expect(trying.to.params.has("tag")).toBe(false)
  })

  it.each([
    ["54", 0, "54 0"],
    ["54", 200, "54 0.2"],
    ["54.3", 1234.5678, "54.3 1.235"],
    ["54 0.5", 100, "54 0.1"],
    ["54\t0.5", 100, "54 0.1"],
    ["54.", 100, "54. 0.1"],
    ["54", -100, "54 0"],
  ])("answers Timestamp %s after %d ms with %s", (timestamp, waited, value) => {
    const invite = request("INVITE", "z9hG4bKinvite", [`Timestamp: ${timestamp}`])
    expect(createTrying(invite, waited).headers).toEqual([{ name: "Timestamp", value }])
  })

  it.each(["", "abc", '5"x', ".5", "5..1", "-1"])(
    "does not echo the malformed Timestamp %j",
    (value) => {
      const invite = request("INVITE", "z9hG4bKinvite", [`Timestamp: ${value}`])
      expect(createTrying(invite, 200).headers).toEqual([])
    },
  )
})
