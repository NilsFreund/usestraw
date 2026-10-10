import { isCallId } from "../message/fields/call-id"
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

export function checkCall(call: string): void {
  if (!isCallId(call)) throw new TypeError(`Invalid call ${show(call)}`)
}

const MAX_SDP = 32 * 1024

export function checkSdp(sdp: Uint8Array): void {
  if (!(sdp instanceof Uint8Array)) throw new TypeError("The SDP must be a Uint8Array")
  if (sdp.length === 0) throw new RangeError("The SDP is empty")
  if (sdp.length > MAX_SDP) {
    throw new RangeError(`The SDP has ${sdp.length} bytes, at most ${MAX_SDP} fit`)
  }
}

export function checkRejection(status: number): void {
  if (!isIntegerIn(status, 400, 699)) {
    throw new RangeError(`A call can be rejected with 400 to 699, got ${show(status)}`)
  }
}

export function checkMaxCalls(maxCalls: number): void {
  if (!isIntegerIn(maxCalls, 0, 0xffff)) {
    throw new RangeError(`maxCalls must be an integer from 0 to 65535, got ${show(maxCalls)}`)
  }
}
