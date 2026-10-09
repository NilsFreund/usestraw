import { isCallId } from "./fields/call-id"
import { isCSeq } from "./fields/cseq"
import { isMaxForwards } from "./fields/max-forwards"
import { isNameAddr } from "./fields/name-addr"
import { isRequestUri } from "./fields/uri"
import { isVia } from "./fields/via"
import { isTypedHeader } from "./headers"
import { isStatusCode } from "./status"
import { hasControl, hasRawControl, isText, isToken, show } from "./syntax"
import { isRequest, type SipMessage, type SipRequest, type SipResponse } from "./types"

export function validateMessage(message: SipMessage): void {
  if (isRequest(message)) validateRequestLine(message)
  else validateStatusLine(message)
  validateFields(message)
}

function validateRequestLine({ method, uri, cseq }: SipRequest): void {
  if (!isToken(method)) invalid(`Invalid method ${show(method)}`)
  if (!isRequestUri(uri)) invalid(`Invalid Request-URI ${show(uri)}`)
  if (cseq.method !== method) {
    invalid(`CSeq method ${show(cseq.method)} does not match ${show(method)}`)
  }
}

function validateStatusLine({ status, reason }: SipResponse): void {
  if (!isStatusCode(status)) invalid(`Invalid status code ${show(status)}`)
  if (!isText(reason) || hasControl(reason)) invalid(`Invalid reason phrase ${show(reason)}`)
}

function validateFields(message: SipMessage): void {
  const { via, from, to, callId, cseq, maxForwards, contact, headers, body } = message
  if (via.length === 0) invalid("Missing Via")
  if (!via.every(isVia)) invalid("Invalid Via")
  if (!isNameAddr(from)) invalid("Invalid From")
  if (!isNameAddr(to)) invalid("Invalid To")
  if (!isCallId(callId)) invalid(`Invalid Call-ID ${show(callId)}`)
  if (!isCSeq(cseq)) invalid("Invalid CSeq")
  if (maxForwards !== undefined && !isMaxForwards(maxForwards)) {
    invalid(`Invalid Max-Forwards ${show(maxForwards)}`)
  }
  if (contact !== "*" && !contact.every(isNameAddr)) invalid("Invalid Contact")
  if (!isBytes(body)) invalid("The body must be a Uint8Array")
  for (const { name, value } of headers) {
    if (!isToken(name)) invalid(`Invalid header name ${show(name)}`)
    if (isTypedHeader(name)) invalid(`Set ${show(name)} through its message field, not as a header`)
    if (hasRawControl(value)) invalid(`Invalid ${name} value ${show(value)}`)
  }
}

function isBytes(value: unknown): boolean {
  return Object.prototype.toString.call(value) === "[object Uint8Array]"
}

function invalid(message: string): never {
  throw new TypeError(message)
}
