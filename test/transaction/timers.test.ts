import { describe, expect, it } from "vitest"
import {
  defaultTimers,
  resolveTimers,
  transactionTimeout,
  validateTimers,
} from "../../src/transaction/timers"

describe("timers", () => {
  it("uses the RFC 3261 defaults", () => {
    expect(defaultTimers).toEqual({ t1: 500, t2: 4000, t4: 5000, d: 32_000, trying: 200 })
  })

  it("derives the transaction timeout from T1", () => {
    expect(transactionTimeout(defaultTimers)).toBe(32_000)
    expect(transactionTimeout({ ...defaultTimers, t1: 100 })).toBe(6400)
  })

  it("fills in unset timers, growing T2 and Timer D with T1", () => {
    expect(resolveTimers()).toStrictEqual(defaultTimers)
    expect(resolveTimers(null)).toStrictEqual(defaultTimers)
    expect(resolveTimers({ t1: undefined, d: undefined })).toStrictEqual(defaultTimers)
    expect(resolveTimers({ t1: 100 })).toStrictEqual({ ...defaultTimers, t1: 100 })
    expect(resolveTimers({ t1: 5000 })).toStrictEqual({
      ...defaultTimers,
      t1: 5000,
      t2: 5000,
      d: 320_000,
    })
    const given = { t1: 5000, t2: 8000, t4: 1, d: 400_000, trying: 0 }
    expect(resolveTimers(given)).toStrictEqual(given)
  })

  it("freezes the defaults", () => {
    expect(Object.isFrozen(defaultTimers)).toBe(true)
  })

  it("accepts the defaults", () => {
    expect(() => validateTimers(defaultTimers)).not.toThrow()
  })

  it.each([{ t2: 500 }, { t4: 0 }, { trying: 0 }, { t1: 100, d: 6400 }])(
    "accepts the boundary %o",
    (change) => {
      expect(() => validateTimers({ ...defaultTimers, ...change })).not.toThrow()
    },
  )

  it.each([
    { t1: Number.POSITIVE_INFINITY },
    { t2: Number.POSITIVE_INFINITY },
    { t4: Number.POSITIVE_INFINITY },
    { d: Number.POSITIVE_INFINITY },
    { trying: Number.NaN },
    { t2: 2 ** 31, d: 2 ** 31 },
    { trying: 2 ** 31 },
  ])("rejects the non-finite or huge %o", (change) => {
    expect(() => validateTimers({ ...defaultTimers, ...change })).toThrow(
      new RangeError("Timer settings must be finite numbers up to 2147483647 ms"),
    )
  })

  it("accepts timers right up to the limit", () => {
    const limit = 2 ** 31 - 1
    expect(() => validateTimers({ ...defaultTimers, t2: limit, t4: limit, d: limit })).not.toThrow()
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
