import { isText } from "../syntax"

// What we accept is anything without spaces; what we send keeps RFC 3261 §25.1: word [ "@" word ]
const CALL_ID = /^[^\s\p{Cc}]+$/u
const WORD = String.raw`[\w\-.!%*+\`'~()<>:\\"/[\]?{}]+`
const STRICT_CALL_ID = new RegExp(`^${WORD}(?:@${WORD})?$`)

export function isCallId(value: string): boolean {
  return isText(value) && CALL_ID.test(value)
}

export function isStrictCallId(value: string): boolean {
  return isText(value) && STRICT_CALL_ID.test(value)
}
