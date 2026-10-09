import { describe, expect, it } from "vitest"
import type { Fate, PacketRecord } from "../../src/simulation/network/types"
import { describeFate, formatTrace } from "../../src/simulation/trace"

function packet(fates: Fate[], overrides: Partial<PacketRecord> = {}): PacketRecord {
  return {
    id: 1,
    sentAt: 100,
    from: "alice",
    to: "bob",
    size: 50,
    copies: 1,
    summary: "OPTIONS sip:bob SIP/2.0",
    fates,
    ...overrides,
  }
}

describe("describeFate", () => {
  const record = packet([])

  it.each<[Fate, string]>([
    [{ type: "delivered", at: 123, host: "bob", corrupted: false }, "+23ms"],
    [{ type: "delivered", at: 130, host: "phone", corrupted: false }, "+30ms at phone"],
    [{ type: "delivered", at: 110, host: "bob", corrupted: true }, "+10ms corrupted"],
    [{ type: "dropped", at: 100, reason: "loss", hop: "internet" }, "lost"],
    [{ type: "dropped", at: 120, reason: "nat", hop: "ingress" }, "dropped: nat"],
  ])("describes %o as %s", (fate, text) => {
    expect(describeFate(record, fate)).toBe(text)
  })
})

describe("formatTrace", () => {
  it("aligns times and lists every fate of a packet", () => {
    expect(
      formatTrace([
        packet([
          { type: "delivered", at: 123, host: "bob", corrupted: false },
          { type: "dropped", at: 140, reason: "outage", hop: "downlink" },
        ]),
        packet([], { sentAt: 2500, from: "bob", to: "alice", summary: "SIP/2.0 200 OK" }),
      ]),
    ).toBe(
      [
        "   100ms  alice → bob  OPTIONS sip:bob SIP/2.0  (+23ms, dropped: outage)",
        "  2500ms  bob → alice  SIP/2.0 200 OK  (in flight)",
      ].join("\n"),
    )
  })

  it("rounds fractional times from bandwidth-limited links", () => {
    const fate: Fate = { type: "delivered", at: 131.25, host: "bob", corrupted: false }
    expect(formatTrace([packet([fate], { sentAt: 100.4 })])).toBe(
      "   100ms  alice → bob  OPTIONS sip:bob SIP/2.0  (+31ms)",
    )
  })

  it("returns an empty string for an empty trace", () => {
    expect(formatTrace([])).toBe("")
  })
})
