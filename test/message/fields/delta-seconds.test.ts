import { describe, expect, it } from "vitest"
import { parseDeltaSeconds } from "../../../src/message/fields/delta-seconds"

describe("parseDeltaSeconds (RFC 3261 §25, §10.2.1.1)", () => {
  it.each([
    ["0", 0],
    ["3600", 3600],
    ["0003600", 3600],
    ["4294967295", 4_294_967_295],
    ["4294967296", 4_294_967_295],
    ["9".repeat(400), 4_294_967_295],
  ])("reads %s as %d", (value, seconds) => {
    expect(parseDeltaSeconds(value)).toBe(seconds)
  })

  it.each(["", " 1", "1 ", "-1", "1.5", "1e3", "0x40", "Infinity", "60abc"])(
    "rejects %j",
    (value) => {
      expect(parseDeltaSeconds(value)).toBeUndefined()
    },
  )

  it("rejects missing values", () => {
    expect(parseDeltaSeconds(undefined)).toBeUndefined()
    expect(parseDeltaSeconds(null)).toBeUndefined()
  })
})
