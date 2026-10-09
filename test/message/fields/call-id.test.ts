import { describe, expect, it } from "vitest"
import { isCallId } from "../../../src/message/fields/call-id"

describe("isCallId", () => {
  it.each(["a84b4c76e66710", "843817637684230@998sdasdh09", "f81d4fae-7dec@[2001:db8::1]"])(
    "accepts %s",
    (value) => {
      expect(isCallId(value)).toBe(true)
    },
  )

  it.each(["", "a b", "a\tb", "a\x00b", "a\r\nX: y", "a\u2028b", "a\x85b"])(
    "rejects %j",
    (value) => {
      expect(isCallId(value)).toBe(false)
    },
  )
})
