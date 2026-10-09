import { describe, expect, it } from "vitest"
import { toHex } from "../../src/support/hex"

describe("toHex", () => {
  it("writes two lowercase digits per byte", () => {
    expect(toHex(Uint8Array.of(0, 9, 171, 255))).toBe("0009abff")
  })

  it("writes nothing for no bytes", () => {
    expect(toHex(new Uint8Array())).toBe("")
  })
})
