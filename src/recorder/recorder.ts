import { version } from "../../package.json"
import { MAX_CALLS, parseAcceptFrom } from "../core/checks"
import { createCore } from "../core/core"
import type { Core, CoreInput, CoreOptions, CoreOutput, Random } from "../core/types"
import { show } from "../message/syntax"
import { isIntegerIn } from "../support/integer"
import { inRange } from "../support/ip"
import { resolveTimers } from "../transaction/timers"
import { decode, encode, maskSecrets } from "./codec"

/** One recorded step: an input, the random draws it took, and what came out. */
export interface RecordedStep {
  readonly now: number
  readonly input: CoreInput
  readonly random: readonly number[]
  readonly next: number | null
  readonly outputs?: readonly CoreOutput[]
  readonly thrown?: string
}

/** Options for `createRecordedCore()`. */
export interface RecorderOptions {
  /** Maximum size in bytes; the oldest steps go first. Defaults to 512 KB. */
  readonly limit?: number | undefined
  readonly onStep?: ((step: RecordedStep) => void) | undefined
}

/** A core that records itself. */
export interface RecordedCore extends Core {
  /** The recording as newline-separated JSON, with password hashes masked. */
  recording(): string
}

const LIMIT = 512 * 1024
const MAX_SIZE = 2 ** 31 - 1

/**
 * Creates a core that records every input, random draw and output, for `replay()`.
 *
 * @experimental `usestraw/core` may change in minor versions while the browser softphone takes shape.
 */
export function createRecordedCore(
  options: CoreOptions,
  settings: RecorderOptions = {},
): RecordedCore {
  const { limit = LIMIT, onStep } = settings
  if (!isIntegerIn(limit, 1024, MAX_SIZE)) throw new RangeError(`Invalid limit ${show(limit)}`)
  let draws: number[] = []
  const random: Random = () => {
    const value = options.random()
    draws.push(value)
    return value
  }
  const core = createCore({ ...options, random })
  const accepted =
    options.acceptFrom === undefined ? undefined : parseAcceptFrom(options.acceptFrom)
  const header = decode(
    encode({
      straw: "recording",
      version: 1,
      release: version,
      options: describe(options),
      random: take(),
      next: core.nextDeadline() ?? null,
    }),
  ) as object
  const lines: string[] = []
  const sizes: number[] = []
  let size = 0
  let truncated = false

  function take(): number[] {
    const taken = draws
    draws = []
    return taken
  }

  function keep(line: string): void {
    const bytes = byteLength(line) + 1
    lines.push(line)
    sizes.push(bytes)
    size += bytes
    while (size > limit) {
      lines.shift()
      size -= sizes.shift() as number
      truncated = true
    }
  }

  function record(step: RecordedStep): void {
    const line = encode(step)
    const bytes = byteLength(line)
    if (bytes > limit / 2) {
      keep(encode({ now: step.now, oversized: bytes }))
      truncated = true
    } else keep(line)
    tell(decode(line) as RecordedStep)
  }

  function tell(step: RecordedStep): void {
    // A debug printer that throws must not take the call down with it
    try {
      onStep?.(step)
    } catch {}
  }

  // A stranger's packet that changed nothing stays out of the trace, so a scan cannot flush it
  function ignored({ input, outputs = [] }: RecordedStep): boolean {
    const [output, ...rest] = outputs
    return (
      input.type === "receive" &&
      accepted !== undefined &&
      !accepted.some((range) => inRange(input.from.host, range)) &&
      rest.length === 0 &&
      output?.type === "event" &&
      (output.event.type === "invalid" || output.event.type === "stray")
    )
  }

  function handle(input: CoreInput, now: number): CoreOutput[] {
    let outputs: CoreOutput[]
    try {
      outputs = core.handle(input, now)
    } catch (error) {
      const thrown = maskSecrets(String(error))
      record({ now, input, random: take(), next: core.nextDeadline() ?? null, thrown })
      throw error
    }
    const step = { now, input, random: take(), next: core.nextDeadline() ?? null, outputs }
    if (!ignored(step)) record(step)
    else if (onStep) tell(decode(encode(step)) as RecordedStep)
    return outputs
  }

  return {
    handle,
    nextDeadline: () => core.nextDeadline(),
    recording: () => [encode({ ...header, truncated }), ...lines, ""].join("\n"),
  }
}

function describe(options: CoreOptions): object {
  const { address, aor, credentials, timers, maxCalls = MAX_CALLS, acceptFrom, media } = options
  const login = credentials && {
    username: credentials.username,
    ...(credentials.realm === undefined ? {} : { realm: credentials.realm }),
  }
  return {
    address,
    aor,
    ...(login ? { credentials: login } : {}),
    timers: resolveTimers(timers),
    maxCalls,
    ...(acceptFrom === undefined ? {} : { acceptFrom }),
    ...(media === undefined ? {} : { media }),
  }
}

function byteLength(text: string): number {
  let bytes = text.length
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 2
      index++
    } else if (code >= 0x800) bytes += 2
    else if (code >= 0x80) bytes += 1
  }
  return bytes
}
