import { describe, expect, it } from "vitest"
import * as straw from "../src"
import * as browser from "../src/browser"

describe("usestraw", () => {
  it("exports exactly these runtime values", () => {
    expect(Object.keys(straw).sort()).toEqual(["ConnectError", "connect"])
  })

  it("has a browser placeholder with the same names, whose connect says it is not supported", async () => {
    expect(Object.keys(browser).sort()).toEqual(Object.keys(straw).sort())
    expect(browser.ConnectError).toBe(straw.ConnectError)
    await expect(browser.connect()).rejects.toMatchObject({
      name: "NotSupportedError",
      message: expect.stringContaining("usestraw/node"),
    })
  })
})
