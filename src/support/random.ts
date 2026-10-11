/** A number in `[0, 1)` like `Math.random`, but cryptographically secure. */
export type Random = () => number

// An integer in [0, range); the clamp keeps a random() that returns 1 by mistake in range
export function randomInt(random: Random, range: number): number {
  return Math.min(range - 1, Math.floor(random() * range))
}
