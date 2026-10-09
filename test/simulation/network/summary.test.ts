import { describe, expect, it } from "vitest"
import { summarize } from "../../../src/simulation/network/summary"
import { bytes } from "../../helpers"

describe("summarize", () => {
  it("returns the start line", () => {
    expect(summarize(bytes("SIP/2.0 200 OK\r\nVia: x\r\n\r\nbody"))).toBe("SIP/2.0 200 OK")
  })

  it("returns everything without a line break", () => {
    expect(summarize(bytes("garbage"))).toBe("garbage")
  })
})
