import { type Core, type CoreOptions, createCore } from "../core/core"
import type { Input, Output, Random } from "../core/types"
import { show } from "../message/syntax"
import { isIntegerIn } from "../support/integer"
import { decode, encode, maskSecrets } from "./codec"

export interface Step {
  readonly now: number
  readonly input: Input
  readonly random: readonly number[]
  readonly next: number | null
  readonly outputs?: readonly Output[]
  readonly thrown?: string
}

export interface RecorderSettings {
  readonly limit?: number | undefined
  readonly onStep?: ((step: Step) => void) | undefined
}

export interface RecordedCore extends Core {
  recording(): string
}

const LIMIT = 512 * 1024

export function createRecordedCore(
  options: CoreOptions,
  settings: RecorderSettings = {},
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

  function record(step: Step): void {
    const line = encode(step)
    const bytes = byteLength(line)
    if (bytes > limit / 2) {
      keep(encode({ now: step.now, oversized: bytes }))
      truncated = true
    } else keep(line)
    if (!onStep) return
    try {
      onStep(decode(line) as Step)
    } catch {}
  }

  function handle(input: Input, now: number): Output[] {
    let outputs: Output[]
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
  const { address, aor, credentials, timers } = options
  const login = credentials && {
    username: credentials.username,
    ...(credentials.realm === undefined ? {} : { realm: credentials.realm }),
  }
  return { address, aor, ...(login ? { credentials: login } : {}), ...(timers ? { timers } : {}) }
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
