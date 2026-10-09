import { describe, expect, it } from "vitest"
import { createResponse } from "../../../src"
import { isRetryable, retryDelay } from "../../../src/core/registration/retry"
import type { RegistrationFailure } from "../../../src/core/types"
import { parsedRequest, register } from "../../helpers"

const request = parsedRequest(register)
const rejected = (status: number): RegistrationFailure => ({
  reason: "rejected",
  status,
  phrase: "",
})
const busy = (value: string) =>
  createResponse(request, 503, "Busy", { headers: [{ name: "Retry-After", value }] })
const almostOne = () => 0.999_999_9

describe("isRetryable", () => {
  it.each([408, 480, 500, 502, 503, 504])("retries %d", (status) => {
    expect(isRetryable(rejected(status))).toBe(true)
  })

  it.each([300, 403, 404, 420, 499, 501, 505, 513, 600, 603, 604, 606])(
    "gives up on %d",
    (status) => {
      expect(isRetryable(rejected(status))).toBe(false)
    },
  )

  it.each([
    [{ reason: "timeout" }, true],
    [{ reason: "not-bound" }, false],
    [{ reason: "no-credentials" }, false],
    [{ reason: "unauthorized", status: 401 }, false],
    [{ reason: "unsupported-challenge", offered: [] }, false],
  ] as [RegistrationFailure, boolean][])("treats %o as retryable: %s", (failure, expected) => {
    expect(isRetryable(failure)).toBe(expected)
  })
})

describe("retryDelay (RFC 5626 §4.5)", () => {
  it("waits between 30 and 60 s after the first failure", () => {
    expect(retryDelay(1, () => 0)).toBe(30_000)
    expect(retryDelay(1, almostOne)).toBe(60_000)
  })

  it("doubles with every further failure up to 30 minutes", () => {
    expect([2, 3, 5, 6, 40].map((failures) => retryDelay(failures, almostOne))).toStrictEqual([
      120_000, 240_000, 960_000, 1_800_000, 1_800_000,
    ])
  })

  it("waits longer when Retry-After asks for it", () => {
    expect(retryDelay(1, () => 0, busy("120"))).toBe(120_000)
    expect(retryDelay(1, () => 0, busy("18000 (lunch);duration=3600"))).toBe(1_800_000)
  })

  it.each(["0", "5", "soon", " 120", "-1"])(
    "never waits less than the backoff for Retry-After %j",
    (value) => {
      expect(retryDelay(1, () => 0, busy(value))).toBe(30_000)
    },
  )

  it("caps an absurd Retry-After at 30 minutes", () => {
    expect(retryDelay(1, () => 0, busy("9".repeat(400)))).toBe(1_800_000)
  })

  it("uses the backoff without Retry-After", () => {
    expect(retryDelay(1, () => 0, createResponse(request, 500, "Error"))).toBe(30_000)
  })
})
