import { type Core, type CoreOptions, createCore } from "../core/core"
import type { Credentials, Output } from "../core/types"
import { decode, encode, maskSecrets } from "./codec"
import type { Step } from "./recorder"

export type ReplayResult =
  | { readonly ok: true; readonly steps: number }
  | {
      readonly ok: false
      readonly reason: "diverged"
      readonly step: number
      readonly expected: string
      readonly actual: string
    }
  | { readonly ok: false; readonly reason: "truncated" | "invalid" }

interface Header {
  readonly truncated: boolean
  readonly random: readonly number[]
  readonly next: number | null
  readonly options: Omit<CoreOptions, "random" | "credentials"> & {
    readonly credentials?: Omit<Credentials, "password">
  }
}

export function replay(recording: string): ReplayResult {
  const [first = "", ...rest] = recording.split("\n").filter((line) => line !== "")
  const header = readHeader(first)
  if (!header) return { ok: false, reason: "invalid" }
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
  let core: Core | undefined
  const start = outcome(
    () => {
      core = createCore({ ...options, random, ...login })
      return []
    },
    () => core?.nextDeadline(),
  )
  const started = encode({ outputs: [], next: header.next })
  if (start !== started || draws.length > 0) {
    return { ok: false, reason: "diverged", step: 0, expected: started, actual: start }
  }
  const running = core as Core
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

function outcome(handle: () => Output[], deadline: () => number | undefined): string {
  try {
    const outputs = handle()
    return encode({ outputs, next: deadline() ?? null })
  } catch (error) {
    return encode({ thrown: maskSecrets(String(error)), next: deadline() ?? null })
  }
}

function readHeader(line: string): Header | undefined {
  const header = parse(line)
  if (!isObject(header) || header["straw"] !== "recording" || header["version"] !== 1) {
    return undefined
  }
  const { random, options, next, truncated } = header
  const valid =
    isDraws(random) &&
    isObject(options) &&
    (next === null || typeof next === "number") &&
    typeof truncated === "boolean"
  return valid ? (header as unknown as Header) : undefined
}

function readSteps(lines: readonly string[]): Step[] | undefined {
  const steps = lines.map(parse)
  const valid = steps.every(
    (step) =>
      isObject(step) &&
      typeof step["now"] === "number" &&
      isObject(step["input"]) &&
      isDraws(step["random"]) &&
      (step["next"] === null || typeof step["next"] === "number") &&
      (Array.isArray(step["outputs"]) || typeof step["thrown"] === "string"),
  )
  return valid ? (steps as Step[]) : undefined
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
