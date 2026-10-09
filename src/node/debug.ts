import { formatStep } from "../recorder/ladder"
import type { Step } from "../recorder/recorder"

const OFF = new Set(["", "0", "false", "off"])

export function debugOutput(
  env: Readonly<Record<string, string | undefined>> = process.env,
  write: (text: string) => void = (text) => process.stderr.write(text),
): ((step: Step) => void) | undefined {
  if (OFF.has((env["STRAW_DEBUG"] ?? "").toLowerCase())) return undefined
  return (step) => {
    const lines = formatStep(step)
    if (lines.length > 0) write(`${lines.join("\n")}\n`)
  }
}
