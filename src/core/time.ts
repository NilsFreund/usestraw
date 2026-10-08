export function earliest(times: Iterable<number | undefined>): number | undefined {
  let next = Number.POSITIVE_INFINITY
  for (const time of times) next = Math.min(next, time ?? Number.POSITIVE_INFINITY)
  return next === Number.POSITIVE_INFINITY ? undefined : next
}
