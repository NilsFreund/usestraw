import { isIntegerIn } from "../support/integer"

export function isStatusCode(code: number): boolean {
  return isIntegerIn(code, 100, 699)
}
