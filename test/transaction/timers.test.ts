import { describe, expect, it } from "vitest"
import { defaultTimers, transactionTimeout, validateTimers } from "../../src/transaction/timers"

describe("timers", () => {
  it("uses the RFC 3261 defaults", () => {
    expect(defaultTimers).toEqual({ t1: 500, t2: 4000, t4: 5000, d: 32_000, trying: 200 })
  })

  it("derives the transaction timeout from T1", () => {
    expect(transactionTimeout(defaultTimers)).toBe(32_000)
    expect(transactionTimeout({ ...defaultTimers, t1: 100 })).toBe(6400)
  })

  it("accepts the defaults", () => {
    expect(() => validateTimers(defaultTimers)).not.toThrow()
  })

  it.each([
    [{ t1: 0 }, "T1 must be positive, got 0"],
    [{ t2: 100 }, "T2 must be at least T1 (500), got 100"],
    [{ t4: -1 }, "T4 must not be negative, got -1"],
    [{ d: 31_999 }, "Timer D must be at least 64*T1 (32000), got 31999"],
    [{ trying: -1 }, "The 100 Trying delay must not be negative, got -1"],
  ])("rejects %o", (change, message) => {
    expect(() => validateTimers({ ...defaultTimers, ...change })).toThrow(new RangeError(message))
  })
})
