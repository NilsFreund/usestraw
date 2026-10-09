import { describe, expect, it } from "vitest"
import * as straw from "../src"

describe("public API", () => {
  it("exports exactly these runtime values", () => {
    expect(Object.keys(straw).sort()).toEqual([
      "createCore",
      "createRecordedCore",
      "createResponse",
      "defaultTimers",
      "getHeader",
      "getHeaders",
      "isRequest",
      "ladder",
      "parseMessage",
      "replay",
      "serializeMessage",
    ])
  })
})
