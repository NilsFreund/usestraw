import { ladderPrinter } from "../recorder/ladder"
import type { RecordedStep } from "../recorder/recorder"

// The browser's STRAW_DEBUG: localStorage.STRAW_DEBUG = "1" prints the ladder to the console
export function webDebug(
  storage: Storage | undefined,
  write: (text: string) => void = (text) => console.log(text),
): ((step: RecordedStep) => void) | undefined {
  try {
    return ladderPrinter(storage?.getItem("STRAW_DEBUG"), write)
  } catch {
    return undefined
  }
}
