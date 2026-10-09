import { headerList } from "./headers"
import { hasLineBreak, show } from "./syntax"
import { isRequest, type SipMessage } from "./types"
import { validateMessage } from "./validate"

const encoder = new TextEncoder()

export function serializeMessage(message: SipMessage): Uint8Array {
  validateMessage(message)
  const startLine = isRequest(message)
    ? `${message.method} ${message.uri} SIP/2.0`
    : `SIP/2.0 ${message.status} ${message.reason}`
  const lines = [startLine, ...headerList(message).map(({ name, value }) => `${name}: ${value}`)]
  const broken = lines.find(hasLineBreak)
  if (broken !== undefined) throw new TypeError(`Line break in ${show(broken)}`)
  const head = encoder.encode(`${lines.join("\r\n")}\r\n\r\n`)
  const bytes = new Uint8Array(head.length + message.body.length)
  bytes.set(head)
  bytes.set(message.body, head.length)
  return bytes
}
