import { headerList } from "./headers"
import { isRequest, type SipMessage } from "./types"

const encoder = new TextEncoder()

export function serializeMessage(message: SipMessage): Uint8Array {
  const startLine = isRequest(message)
    ? `${message.method} ${message.uri} SIP/2.0`
    : `SIP/2.0 ${message.status} ${message.reason}`
  const lines = [startLine, ...headerList(message).map(({ name, value }) => `${name}: ${value}`)]
  const head = encoder.encode(`${lines.join("\r\n")}\r\n\r\n`)
  const bytes = new Uint8Array(head.length + message.body.length)
  bytes.set(head)
  bytes.set(message.body, head.length)
  return bytes
}
