const MAX_DELTA = 0xffffffff

// RFC 3261 §25: delta-seconds = 1*DIGIT; §10.2.1.1 treats anything above 2^32-1 as 2^32-1
export function parseDeltaSeconds(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || !/^\d+$/.test(value)) return undefined
  return Math.min(Number(value), MAX_DELTA)
}
