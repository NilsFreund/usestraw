import { SAMPLES_PER_MS } from "./g711"

export interface Heard {
  readonly ssrc: number
  readonly sequence: number
  readonly timestamp: number
  readonly pcm: Int16Array
}

export interface Jitter {
  push(heard: Heard, now: number): void
  read(samples: number, now: number): Int16Array<ArrayBuffer>
}

const TARGET = 60 * SAMPLES_PER_MS
const MAX_DEPTH = 200 * SAMPLES_PER_MS
const MAX_GAP = 100 * SAMPLES_PER_MS
const RESYNC = 2000 * SAMPLES_PER_MS
const MAX_PACKETS = 50
const SILENT = 100

/** An adaptive playout buffer in samples: clock drift, stalls and gaps cost audio, not the call. */
export function createJitter(): Jitter {
  const chunks = new Map<number, Int16Array>()
  let source: number | undefined
  let cursor = 0
  let ready = false
  let waiting: number | undefined
  let heardAt = Number.NEGATIVE_INFINITY

  function start(heard: Heard): void {
    source = heard.ssrc
    cursor = heard.timestamp
    ready = false
    waiting = undefined
    chunks.clear()
  }

  // RFC 3550 §8.2: a new source takes over once the old one went quiet, so two streams cannot fight
  function believe(heard: Heard, now: number): boolean {
    if (heard.ssrc === source) return true
    if (source !== undefined && now - heardAt <= SILENT) return false
    start(heard)
    return true
  }

  function push(heard: Heard, now: number): void {
    if (!believe(heard, now)) return
    heardAt = now
    if (Math.abs(offset(heard.timestamp, cursor)) > RESYNC) start(heard)
    if (chunks.size >= MAX_PACKETS || chunks.has(heard.timestamp)) return
    chunks.set(heard.timestamp, heard.pcm)
    waiting ??= now
  }

  function depth(from: number): number {
    let deepest = 0
    for (const [timestamp, pcm] of chunks) {
      const end = offset(timestamp + pcm.length, from)
      if (end <= 0) chunks.delete(timestamp)
      else deepest = Math.max(deepest, end)
    }
    return deepest
  }

  function read(samples: number, now: number): Int16Array<ArrayBuffer> {
    const frame = new Int16Array(samples)
    if (source === undefined) return frame
    const buffered = depth(cursor)
    if (
      !ready &&
      (buffered >= TARGET || (waiting !== undefined && now - waiting >= TARGET / SAMPLES_PER_MS))
    ) {
      ready = true
    }
    if (!ready) return frame
    if (buffered > MAX_DEPTH) cursor = (cursor + buffered - TARGET) >>> 0
    let filled = 0
    while (filled < samples) {
      const at: number = cursor
      const next = [...chunks].reduce<[number, Int16Array] | undefined>(
        (best, entry) => (!best || offset(entry[0], at) < offset(best[0], at) ? entry : best),
        undefined,
      )
      if (!next) {
        ready = false
        waiting = undefined
        break
      }
      const [timestamp, pcm] = next
      const gap = offset(timestamp, at)
      if (gap + pcm.length <= 0) {
        chunks.delete(timestamp)
        continue
      }
      if (gap > MAX_GAP) {
        cursor = timestamp
        continue
      }
      const start = Math.max(0, -gap)
      const length =
        gap > 0 ? Math.min(gap, samples - filled) : Math.min(pcm.length - start, samples - filled)
      if (gap <= 0) frame.set(pcm.subarray(start, start + length), filled)
      if (gap <= 0 && start + length >= pcm.length) chunks.delete(timestamp)
      filled += length
      cursor = (at + length) >>> 0
    }
    return frame
  }

  return { push, read }
}

// RFC 3550 §5.1: timestamps wrap at 2^32, so differences are taken as signed 32-bit numbers
function offset(a: number, b: number): number {
  return (a - b) | 0
}
