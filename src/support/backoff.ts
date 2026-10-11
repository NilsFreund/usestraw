import type { Random } from "./random"

// RFC 5626 §4.5: min(max, base · 2^attempt), randomized between 50 % and 100 %
export function backoff(attempt: number, base: number, max: number, random: Random): number {
  return Math.round(Math.min(max, base * 2 ** attempt) * (0.5 + random() / 2))
}
