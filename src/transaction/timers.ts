import { MAX_DELAY } from "../support/time"
/**
 * The RFC 3261 §17 transaction timers, in milliseconds: T2 at least T1, Timer D at least 64·T1,
 * none above 2³¹−1.
 */
export interface TimerSettings {
  readonly t1: number
  readonly t2: number
  readonly t4: number
  readonly d: number
  readonly trying: number
}

/** The RFC 3261 defaults: T1 500 ms, T2 4 s, T4 5 s, Timer D 32 s, 100 Trying after 200 ms. */
export const defaultTimers: TimerSettings = Object.freeze({
  t1: 500,
  t2: 4000,
  t4: 5000,
  d: 32_000,
  trying: 200,
})

// T2 and Timer D grow with T1, so setting T1 alone stays valid
export function resolveTimers(
  timers?: Partial<Record<keyof TimerSettings, number | undefined>> | null,
): TimerSettings {
  const given = timers ?? {}
  const { t1 = defaultTimers.t1 } = given
  const {
    t2 = Math.max(defaultTimers.t2, t1),
    t4 = defaultTimers.t4,
    d = Math.max(defaultTimers.d, 64 * t1),
    trying = defaultTimers.trying,
  } = given
  return { t1, t2, t4, d, trying }
}

export function transactionTimeout(timers: TimerSettings): number {
  return 64 * timers.t1
}

export function validateTimers(timers: TimerSettings): void {
  const { t1, t2, t4, d, trying } = timers
  if (![t1, t2, t4, d, trying].every((value) => Number.isFinite(value) && value <= MAX_DELAY)) {
    throw new RangeError(`Timer settings must be finite numbers up to ${MAX_DELAY} ms`)
  }
  if (t1 <= 0) throw new RangeError(`T1 must be positive, got ${t1}`)
  if (t2 < t1) throw new RangeError(`T2 must be at least T1 (${t1}), got ${t2}`)
  if (t4 < 0) throw new RangeError(`T4 must not be negative, got ${t4}`)
  const minimum = transactionTimeout(timers)
  if (d < minimum) throw new RangeError(`Timer D must be at least 64*T1 (${minimum}), got ${d}`)
  if (trying < 0) throw new RangeError(`The 100 Trying delay must not be negative, got ${trying}`)
}
