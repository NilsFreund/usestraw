import { isIp } from "../message/fields/host"
import { isRequestUri, splitSipUri } from "../message/fields/uri"
import { hasLineBreak, isText, show } from "../message/syntax"
import { isIntegerIn } from "../support/integer"
import { type Address, isAddress } from "../transport/address"
import type { Credentials } from "./types"

export function checkAddress(address: Address): void {
  if (!isAddress(address)) throw new TypeError(`Invalid address ${show(address)}`)
}

export function checkSource(from: Address): void {
  checkAddress(from)
  if (!isIp(from.host))
    throw new TypeError(`The source must be an IP address, got ${show(from.host)}`)
}

export function checkRequestUri(uri: string): void {
  if (!isRequestUri(uri)) throw new TypeError(`Invalid Request-URI ${show(uri)}`)
}

// RFC 3261 §25.1: callid = word [ "@" word ]
const WORD = String.raw`[\w\-.!%*+\`'~()<>:\\"/[\]?{}]+`
const CALL_ID = new RegExp(`^${WORD}(?:@${WORD})?$`)

export function checkCallId(callId: string): void {
  if (!isText(callId) || callId.length > 256 || !CALL_ID.test(callId)) {
    throw new TypeError(`Invalid Call-ID ${show(callId)}`)
  }
}

export function checkRegistrar(registrar: string | undefined): asserts registrar is string {
  const parts = registrar === undefined ? undefined : splitSipUri(registrar)
  if (registrar === undefined || !parts || parts.user !== undefined || !isRequestUri(registrar)) {
    throw new TypeError(`Invalid registrar ${show(registrar)}`)
  }
}

export function checkExpires(expires: number): void {
  if (!isIntegerIn(expires, 1, 0xffffffff)) throw new RangeError(`Invalid expires ${expires}`)
}

export function checkCredentials(credentials: Credentials): void {
  const { username, password, realm = "" } = credentials
  const valid = [username, password, realm].every((value) => isText(value) && !hasLineBreak(value))
  if (!valid) throw new TypeError("Credentials must be strings without line breaks")
}
