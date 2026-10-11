import { afterEach, describe, expect, it, vi } from "vitest"
import type { RecordedStep } from "../../src/core"
import { debugOutput } from "../../src/node/debug"
import { bob, bytes } from "../helpers"

const sending: RecordedStep = {
  now: 0,
  input: { type: "timeout" },
  random: [],
  next: null,
  outputs: [{ type: "send", data: bytes("REGISTER sip:example.com SIP/2.0\r\n\r\n"), to: bob }],
}
const quiet: RecordedStep = {
  now: 0,
  input: { type: "timeout" },
  random: [],
  next: null,
  outputs: [],
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("debugOutput", () => {
  it.each([
    {},
    { STRAW_DEBUG: "" },
    { STRAW_DEBUG: "0" },
    { STRAW_DEBUG: "false" },
    { STRAW_DEBUG: "OFF" },
  ])("stays quiet with %j", (env) => {
    expect(debugOutput(env)).toBeUndefined()
  })

  it("prints the ladder lines of every step that has any", () => {
    const written: string[] = []
    const print = debugOutput({ STRAW_DEBUG: "1" }, (text) => written.push(text))
    print?.(sending)
    print?.(quiet)
    expect(written).toStrictEqual([
      "    0.000  phone → 192.0.2.20:5060  REGISTER sip:example.com SIP/2.0\n",
    ])
  })

  it("reads STRAW_DEBUG from the environment and writes to stderr", () => {
    vi.stubEnv("STRAW_DEBUG", "1")
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    debugOutput()?.(sending)
    expect(write).toHaveBeenCalledWith(expect.stringContaining("phone → 192.0.2.20:5060"))
  })
})
