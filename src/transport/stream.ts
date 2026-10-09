import { findBlankLine } from "../message/framing"
import { MAX_MESSAGE_SIZE } from "../message/limits"
import { splitHeaderLine } from "../message/parse"
import { show } from "../message/syntax"

export type StreamEvent =
  | { readonly type: "message"; readonly data: Uint8Array }
  | { readonly type: "ping" }
  | { readonly type: "pong" }
  | { readonly type: "error"; readonly error: string }

export interface StreamFramer {
  readonly buffered: number
  push(chunk: Uint8Array): StreamEvent[]
}

const CR = 13
const LF = 10
const decoder = new TextDecoder()

// RFC 3261 §18.3: Content-Length frames messages on streams;
// RFC 3261 §7.5 and RFC 5626 §3.5.1: CR/LF runs before a start line are keepalives
export function createStreamFramer(): StreamFramer {
  let bytes = new Uint8Array(4096)
  let start = 0
  let end = 0
  let scanned = 0
  let total: number | undefined
  let halfPing = false
  let broken = false

  function push(chunk: Uint8Array): StreamEvent[] {
    if (broken) return []
    append(chunk)
    const events: StreamEvent[] = []
    for (let event = next(); event; event = next()) {
      events.push(event)
      if (event.type === "error") {
        broken = true
        break
      }
    }
    return events
  }

  function next(): StreamEvent | undefined {
    const keepalive = keepaliveRun()
    if (keepalive) return keepalive
    const broken = total === undefined ? measure() : undefined
    if (broken) return broken
    if (total !== undefined && end - start >= total) return message(total)
    if (end - start > MAX_MESSAGE_SIZE) return failure(`Message exceeds ${MAX_MESSAGE_SIZE} bytes`)
    return undefined
  }

  function keepaliveRun(): StreamEvent | undefined {
    let index = start
    while (index < end && (bytes[index] === CR || bytes[index] === LF)) index++
    if (index === start || (index === end && bytes[end - 1] === CR)) return undefined
    const run = decoder.decode(bytes.subarray(start, index))
    const ping = run.includes("\r\n\r\n") || (halfPing && run.startsWith("\r\n"))
    halfPing = !ping && run.endsWith("\r\n")
    start = index
    scanned = 0
    if (ping) return { type: "ping" }
    return run.includes("\r\n") ? { type: "pong" } : undefined
  }

  function measure(): StreamEvent | undefined {
    const found = findBlankLine(bytes.subarray(start, end), scanned)
    if (!found) {
      scanned = Math.max(0, end - start - 2)
      return undefined
    }
    const [headEnd, bodyStart] = found
    const lines = decoder.decode(bytes.subarray(start, start + headEnd)).split(/\r?\n/)
    const lengths = lines.flatMap((line) => {
      const header = splitHeaderLine(line)
      return header?.name === "Content-Length" ? [header.value.trim()] : []
    })
    const [length] = lengths
    if (length === undefined) return failure("Missing Content-Length on a stream")
    if (lengths.some((value) => value !== length))
      return failure("Conflicting Content-Length headers")
    if (!/^\d+$/.test(length)) return failure(`Invalid Content-Length ${show(length)}`)
    const size = bodyStart + Number(length)
    if (size > MAX_MESSAGE_SIZE) return failure(`Message exceeds ${MAX_MESSAGE_SIZE} bytes`)
    total = size
    return undefined
  }

  function message(size: number): StreamEvent {
    const data = bytes.slice(start, start + size)
    start += size
    scanned = 0
    total = undefined
    halfPing = false
    return { type: "message", data }
  }

  function append(chunk: Uint8Array): void {
    if (end + chunk.length > bytes.length) {
      const live = bytes.subarray(start, end)
      const grown = new Uint8Array(Math.max(bytes.length, (live.length + chunk.length) * 2))
      grown.set(live)
      bytes = grown
      end = live.length
      start = 0
    }
    bytes.set(chunk, end)
    end += chunk.length
  }

  return {
    get buffered() {
      return end - start
    },
    push,
  }
}

function failure(error: string): StreamEvent {
  return { type: "error", error }
}
