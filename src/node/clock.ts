const MAX_DELAY = 2 ** 31 - 1

export interface Clock {
  now(): number
  schedule(at: number | undefined, fire: () => void): void
  cancel(): void
}

export function createClock(): Clock {
  const origin = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const now = () => performance.now() - origin

  function schedule(at: number | undefined, fire: () => void): void {
    cancel()
    if (at !== undefined) timer = setTimeout(fire, Math.min(MAX_DELAY, Math.max(0, at - now())))
  }

  function cancel(): void {
    clearTimeout(timer)
  }

  return { now, schedule, cancel }
}
