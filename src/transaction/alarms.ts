import { earliest } from "../support/time"

export interface Alarms<Name extends string> {
  set(name: Name, at: number): void
  clear(...names: Name[]): void
  next(): number | undefined
  take(now: number): Name[]
}

export function createAlarms<Name extends string>(): Alarms<Name> {
  const alarms = new Map<Name, number>()

  function take(now: number): Name[] {
    const due = [...alarms].filter(([, at]) => at <= now).sort(([, a], [, b]) => a - b)
    for (const [name] of due) alarms.delete(name)
    return due.map(([name]) => name)
  }

  return {
    set: (name, at) => {
      alarms.set(name, at)
    },
    clear: (...names) => {
      for (const name of names) alarms.delete(name)
    },
    next: () => earliest(alarms.values()),
    take,
  }
}
