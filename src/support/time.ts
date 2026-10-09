export function earliest(times: Iterable<number | undefined>): number | undefined {
  let next = Number.POSITIVE_INFINITY
  for (const time of times) next = Math.min(next, time ?? Number.POSITIVE_INFINITY)
  return next === Number.POSITIVE_INFINITY ? undefined : next
}

export function checkTime(now: number): void {
  if (!(Math.abs(now) <= Number.MAX_SAFE_INTEGER)) throw new RangeError(`Invalid time ${now}`)
}
