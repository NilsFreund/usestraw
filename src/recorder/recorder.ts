import { version } from "../../package.json"
import { type Core, type CoreOptions, createCore } from "../core/core"
import type { CoreInput, CoreOutput, Random } from "../core/types"
import { show } from "../message/syntax"
import { isIntegerIn } from "../support/integer"
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

/** Options for {@link createRecordedCore}. */
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

/** Creates a core that records every input, random draw and output, for {@link replay}. */
export function createRecordedCore(
  options: CoreOptions,
  settings: RecorderOptions = {},
): RecordedCore {
  const { limit = LIMIT, onStep } = settings
  if (!isIntegerIn(limit, 1024, 2 ** 31 - 1)) throw new RangeError(`Invalid limit ${show(limit)}`)
  let draws: number[] = []
  const random: Random = () => {
    const value = options.random()
    draws.push(value)
    return value
  }
  const core = createCore({ ...options, random })
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
    if (!onStep) return
    try {
      onStep(decode(line) as RecordedStep)
    } catch {}
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
    record({ now, input, random: take(), next: core.nextDeadline() ?? null, outputs })
    return outputs
  }

  return {
    handle,
    nextDeadline: () => core.nextDeadline(),
    recording: () => [encode({ ...header, truncated }), ...lines, ""].join("\n"),
  }
}

function describe(options: CoreOptions): object {
  const { address, aor, credentials, timers, maxCalls = 100, acceptFrom } = options
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
