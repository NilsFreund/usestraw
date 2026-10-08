import { describe, expect, it } from "vitest"
import { formatCSeq, parseCSeq } from "../../../src/message/fields/cseq"
import { ParseError } from "../../../src/message/syntax"

describe("parseCSeq", () => {
  it("parses sequence number and method", () => {
    expect(parseCSeq("0009   INVITE")).toEqual({ seq: 9, method: "INVITE" })
  })

  it("accepts the largest 32-bit sequence number", () => {
    expect(parseCSeq("4294967295 BYE").seq).toBe(4294967295)
  })

  it.each(["4294967296 INVITE", "1", "INVITE 1", "-1 INVITE", "1 IN VITE"])(
    "rejects %s",
    (value) => {
      expect(() => parseCSeq(value)).toThrow(ParseError)
    },
  )
})

describe("formatCSeq", () => {
  it("writes number and method", () => {
    expect(formatCSeq({ seq: 1, method: "REGISTER" })).toBe("1 REGISTER")
  })
})
