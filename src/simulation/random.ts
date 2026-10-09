import type { Random } from "../core/types"

export function createRandom(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export function deriveSeed(seed: number, label: string): number {
  let hash = 0x811c9dc5
  for (const char of `${seed}:${label}`) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193)
  return hash >>> 0
}

export function createStreams(seed: number): (label: string) => Random {
  const streams = new Map<string, Random>()
  return (label) => {
    const existing = streams.get(label)
    if (existing) return existing
    const stream = createRandom(deriveSeed(seed, label))
    streams.set(label, stream)
    return stream
  }
}

export function between(random: Random, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1))
}

export function chance(random: Random, probability: number): boolean {
  return random() < probability
}

export function gaussian(random: Random, mean: number, deviation: number): number {
  const radius = Math.sqrt(-2 * Math.log(1 - random()))
  return mean + deviation * radius * Math.cos(2 * Math.PI * random())
}
