import { backoff } from "../support/backoff"
import { secureRandom } from "./random"

const FIRST = 1000
const MAX = 60_000
// A connection that held for a minute starts the next round of attempts short again
const STABLE = 60_000

export interface Retry {
  /** Runs `fire` after the next backoff delay and returns that delay. */
  later(fire: () => void): number
  after(delay: number, fire: () => void): void
  cancel(): void
  online(): void
  lost(): void
}

export function createRetry(): Retry {
  let attempts = 0
  let onlineAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  function after(delay: number, fire: () => void): void {
    clearTimeout(timer)
    timer = setTimeout(fire, delay)
  }

  return {
    later: (fire) => {
      const delay = backoff(attempts, FIRST, MAX, secureRandom)
      attempts += 1
      after(delay, fire)
      return delay
    },
    after,
    cancel: () => clearTimeout(timer),
    online: () => {
      onlineAt = performance.now()
    },
    lost: () => {
      if (performance.now() - onlineAt > STABLE) attempts = 0
    },
  }
}
