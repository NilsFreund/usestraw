import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRetry } from "../../src/phone/retry"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("createRetry", () => {
  it("keeps one timer at a time", async () => {
    const retry = createRetry()
    const fired: string[] = []
    retry.after(1000, () => fired.push("first"))
    retry.after(1000, () => fired.push("second"))
    await vi.advanceTimersByTimeAsync(2000)
    expect(fired).toStrictEqual(["second"])
  })
})
