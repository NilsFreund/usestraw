import { headerList } from "./headers"
import { MAX_MESSAGE_SIZE } from "./limits"
import { hasLineBreak, show } from "./syntax"
import { isRequest, type SipMessage } from "./types"
import { validateMessage } from "./validate"

const encoder = new TextEncoder()

/**
 * Serializes a message for the wire. Every field is validated first.
 *
 * @throws {TypeError} for a message that would not be valid SIP
 * @throws {RangeError} for a message above 65,535 bytes, which no Straw parser would take
 */
export function serializeMessage(message: SipMessage): Uint8Array {
  const bytes = encodeMessage(message)
  if (bytes.length > MAX_MESSAGE_SIZE) {
    throw new RangeError(`Message exceeds ${MAX_MESSAGE_SIZE} bytes`)
  }
  return bytes
}

export function encodeMessage(message: SipMessage): Uint8Array {
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
