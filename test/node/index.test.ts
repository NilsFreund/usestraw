import { describe, expect, it } from "vitest"
import * as node from "../../src/node"

describe("usestraw/node", () => {
  it("exports exactly these runtime values", () => {
    expect(Object.keys(node).sort()).toEqual(["ConnectError", "connect"])
  })
})
