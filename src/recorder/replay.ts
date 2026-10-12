import { version } from "../../package.json"
import { createCore } from "../core/core"
import type { Core, CoreOptions, CoreOutput, Credentials } from "../core/types"
import { decode, encode, maskSecrets } from "./codec"
import type { RecordedStep } from "./recorder"

/** Whether a replay matched the recording, and where it first diverged if not. */
export type ReplayResult =
  | { readonly ok: true; readonly steps: number }
  | {
      readonly ok: false
      readonly reason: "diverged"
      readonly step: number
      readonly expected: string
      readonly actual: string
    }
  | { readonly ok: false; readonly reason: "version"; readonly version: string }
  | { readonly ok: false; readonly reason: "truncated" | "invalid" }

interface RecordingHeader {
  readonly release: string
  readonly truncated: boolean
  readonly random: readonly number[]
  readonly next: number | null
  readonly options: Omit<CoreOptions, "random" | "credentials"> & {
    readonly credentials?: Omit<Credentials, "password">
  }
}

/**
 * Reruns a recording on a fresh core and checks that every step gives the same outputs. It needs
 * the usestraw version that made the recording, and says which one otherwise.
 */
export function replay(recording: string): ReplayResult {
  const [first = "", ...rest] = recording.split("\n").filter((line) => line !== "")
  const header = readHeader(first)
  if (!header) return { ok: false, reason: "invalid" }
  if (header.release !== version) return { ok: false, reason: "version", version: header.release }
  if (header.truncated) return { ok: false, reason: "truncated" }
  const steps = readSteps(rest)
  if (!steps) return { ok: false, reason: "invalid" }
  const draws = [...header.random]
  const random = () => {
    const value = draws.shift()
    if (value === undefined) throw new Error("The recording has no random draw left here")
    return value
  }
  const { credentials, ...options } = header.options
  const login = credentials ? { credentials: { ...credentials, password: "" } } : {}
  const started = encode({ outputs: [], next: header.next })
  let running: Core
  try {
    running = createCore({ ...options, random, ...login })
  } catch (error) {
    const actual = encode({ thrown: maskSecrets(String(error)), next: null })
    return { ok: false, reason: "diverged", step: 0, expected: started, actual }
  }
  const start = encode({ outputs: [], next: running.nextDeadline() ?? null })
  if (start !== started || draws.length > 0) {
    return { ok: false, reason: "diverged", step: 0, expected: started, actual: start }
  }
  for (const [index, step] of steps.entries()) {
    draws.push(...step.random)
    const actual = outcome(
      () => running.handle(step.input, step.now),
      () => running.nextDeadline(),
    )
    const expected = encode(
      step.thrown === undefined
        ? { outputs: step.outputs, next: step.next }
        : { thrown: step.thrown, next: step.next },
    )
    if (actual !== expected || draws.length > 0) {
      return { ok: false, reason: "diverged", step: index + 1, expected, actual }
    }
  }
  return { ok: true, steps: steps.length }
}

function outcome(handle: () => CoreOutput[], deadline: () => number | undefined): string {
  try {
    const outputs = handle()
    return encode({ outputs, next: deadline() ?? null })
  } catch (error) {
    return encode({ thrown: maskSecrets(String(error)), next: deadline() ?? null })
  }
}

function readHeader(line: string): RecordingHeader | undefined {
  const header = parse(line)
  return isHeader(header) ? header : undefined
}

function readSteps(lines: readonly string[]): RecordedStep[] | undefined {
  const steps = lines.map(parse)
  return steps.every(isStep) ? steps : undefined
}

// The shape a recording promises; inputs and options are checked by the core when it runs them
function isHeader(value: unknown): value is RecordingHeader {
  if (!isObject(value) || value["straw"] !== "recording" || value["version"] !== 1) return false
  const { release, random, options, next, truncated } = value
  return (
    typeof release === "string" &&
    isDraws(random) &&
    isObject(options) &&
    (next === null || typeof next === "number") &&
    typeof truncated === "boolean"
  )
}

function isStep(value: unknown): value is RecordedStep {
  return (
    isObject(value) &&
    typeof value["now"] === "number" &&
    isObject(value["input"]) &&
    isDraws(value["random"]) &&
    (value["next"] === null || typeof value["next"] === "number") &&
    (Array.isArray(value["outputs"]) || typeof value["thrown"] === "string")
  )
}

function parse(line: string): unknown {
  try {
    return decode(line)
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isDraws(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((draw) => typeof draw === "number")
}
