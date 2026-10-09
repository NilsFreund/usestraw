import { isText } from "../syntax"

const CALL_ID = /^[^\s\p{Cc}]+$/u

export function isCallId(value: string): boolean {
  return isText(value) && CALL_ID.test(value)
}
