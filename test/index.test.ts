import { describe, expect, it } from "vitest"
import * as manifest from "../package.json"
import * as straw from "../src"
import * as browser from "../src/browser"

describe("usestraw", () => {
  it("exports exactly these runtime values", () => {
    expect(Object.keys(straw).sort()).toEqual(["ConnectError", "connect"])
  })

  it("has no runtime dependencies, as the README badge says", () => {
    const runtime = ["dependencies", "peerDependencies", "optionalDependencies"]
    expect(Object.keys(manifest).filter((key) => runtime.includes(key))).toEqual([])
  })

  // webpack's electron-renderer target sets both node and browser, so no node key may come first
  it("sends browsers to the placeholder and keeps usestraw/node out of their reach", () => {
    expect(Object.keys(manifest.exports["."])).toStrictEqual(["types", "browser", "default"])
    expect(Object.keys(manifest.exports["./node"])).toStrictEqual(["types", "default"])
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
