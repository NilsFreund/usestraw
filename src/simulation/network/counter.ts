export interface Counter {
  add(key: string): void
  remove(key: string): void
  has(key: string): boolean
}

export function createCounter(): Counter {
  const counts = new Map<string, number>()

  function bump(key: string, delta: number): void {
    const count = (counts.get(key) ?? 0) + delta
    if (count > 0) counts.set(key, count)
    else counts.delete(key)
  }

  return {
    add: (key) => bump(key, 1),
    remove: (key) => bump(key, -1),
    has: (key) => counts.has(key),
  }
}
