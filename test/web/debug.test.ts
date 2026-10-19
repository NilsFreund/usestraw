import { afterEach, describe, expect, it, vi } from "vitest"
import type { RecordedStep } from "../../src/recorder/recorder"
import { webDebug } from "../../src/web/debug"
import { fakeStorage } from "./fakes"

const step: RecordedStep = {
  now: 1234,
  input: { type: "timeout" },
  random: [],
  outputs: [{ type: "event", event: { type: "registration", state: "registered", expires: 600 } }],
  next: null,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("webDebug", () => {
  it.each([undefined, "", "0", "false", "OFF"])("stays quiet with STRAW_DEBUG=%j", (setting) => {
    const storage = fakeStorage(setting === undefined ? {} : { STRAW_DEBUG: setting })
    expect(webDebug(storage)).toBeUndefined()
  })

  it("prints the ladder to the console when STRAW_DEBUG is set", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    webDebug(fakeStorage({ STRAW_DEBUG: "1" }))?.(step)
    expect(log).toHaveBeenCalledWith("    1.234  ● online for 600 s")
    webDebug(fakeStorage({ STRAW_DEBUG: "1" }))?.({ ...step, outputs: [] })
    expect(log).toHaveBeenCalledTimes(1)
  })

  it("stays quiet without storage or when reading it throws", () => {
    expect(webDebug(undefined)).toBeUndefined()
    const broken = fakeStorage()
    broken.getItem = () => {
      throw new DOMException("denied", "SecurityError")
    }
    expect(webDebug(broken)).toBeUndefined()
  })
})
