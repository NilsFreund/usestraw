import { describe, expect, it } from "vitest"
import { formatTrace, summarize } from "../../src/simulation/trace"
import { bytes } from "../helpers"

describe("summarize", () => {
  it("returns the start line", () => {
    expect(summarize(bytes("SIP/2.0 200 OK\r\nVia: x\r\n\r\nbody"))).toBe("SIP/2.0 200 OK")
  })

  it("returns everything without a line break", () => {
    expect(summarize(bytes("garbage"))).toBe("garbage")
  })
})

describe("formatTrace", () => {
  it("aligns times and shows latency or loss", () => {
    expect(
      formatTrace([
        { sentAt: 0, deliverAt: 23, from: "alice", to: "bob", summary: "OPTIONS sip:bob SIP/2.0" },
        { sentAt: 23, deliverAt: null, from: "bob", to: "alice", summary: "SIP/2.0 200 OK" },
      ]),
    ).toBe(
      [
        "     0ms  alice → bob  OPTIONS sip:bob SIP/2.0  (+23ms)",
        "    23ms  bob → alice  SIP/2.0 200 OK  (lost)",
      ].join("\n"),
    )
  })

  it("returns an empty string for an empty trace", () => {
    expect(formatTrace([])).toBe("")
  })
})
