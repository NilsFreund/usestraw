import { ladderPrinter } from "../recorder/ladder"
import type { RecordedStep } from "../recorder/recorder"

export function debugOutput(
  env: Readonly<Record<string, string | undefined>> = process.env,
  write: (text: string) => void = (text) => process.stderr.write(text),
): ((step: RecordedStep) => void) | undefined {
  return ladderPrinter(env["STRAW_DEBUG"], (text) => write(`${text}\n`))
}
