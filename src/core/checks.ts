import { isCallId } from "../message/fields/call-id"
import { isIp } from "../message/fields/host"
import { isRequestUri, isUri, splitSipUri } from "../message/fields/uri"
import { hasLineBreak, isText, show } from "../message/syntax"
import { familyOf, isUnspecified } from "../sdp/address"
import type { MediaAddress } from "../sdp/types"
import { isIntegerIn } from "../support/integer"
import { isAddress, type TransportAddress } from "../transport/address"
import type { Credentials, LocalMedia } from "./types"

export function checkAddress(address: TransportAddress): void {
  if (!isAddress(address)) throw new TypeError(`Invalid address ${show(address)}`)
}

export function checkSource(from: TransportAddress): void {
  checkAddress(from)
  if (!isIp(from.host))
    throw new TypeError(`The source must be an IP address, got ${show(from.host)}`)
}

const MAX_TEXT = 4096

export function checkRequestUri(uri: string): void {
  if (!isRequestUri(uri)) throw new TypeError(`Invalid Request-URI ${show(uri)}`)
  checkLength(uri, "URI")
}

export function checkAor(aor: string): void {
  if (!isUri(aor)) throw new TypeError(`Invalid address of record ${show(aor)}`)
  checkLength(aor, "URI")
}

function checkLength(value: string, what: string): void {
  if (value.length > MAX_TEXT) {
    throw new RangeError(`A ${what} must be at most ${MAX_TEXT} characters, got ${value.length}`)
  }
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
  checkLength(registrar, "URI")
}

export function checkExpires(expires: number): void {
  if (!isIntegerIn(expires, 1, 0xffffffff)) throw new RangeError(`Invalid expires ${expires}`)
}

export function checkCredentials(credentials: Credentials): void {
  const { username, password, realm = "" } = credentials
  const valid = [username, password, realm].every((value) => isText(value) && !hasLineBreak(value))
  if (!valid) throw new TypeError("Credentials must be strings without line breaks")
  checkLength(username, "user name")
  checkLength(realm, "realm")
}

export function checkCall(call: string): void {
  if (!isCallId(call)) throw new TypeError(`Invalid call ${show(call)}`)
}

// RFC 3550 §11: RTP takes an even port, and the far end must be able to send to our host
export function checkMedia(media: LocalMedia, fallback: string): MediaAddress {
  if (typeof media !== "object" || media === null)
    throw new TypeError(`Invalid media ${show(media)}`)
  const raw = media.host ?? fallback
  const host = typeof raw === "string" ? raw.replace(/^\[(.*)\]$/, "$1") : ""
  if (!familyOf(host) || isUnspecified(host)) {
    throw new TypeError(
      `The media host must be an IP address the far end can reach, got ${show(raw)}`,
    )
  }
  const { port } = media
  if (!isIntegerIn(port, 2, 65534) || port % 2 !== 0) {
    throw new RangeError(`The media port must be an even number from 2 to 65534, got ${show(port)}`)
  }
  return { host, port }
}

export function checkRejection(status: number): void {
  if (!isIntegerIn(status, 400, 699)) {
    throw new RangeError(`A call can be rejected with 400 to 699, got ${show(status)}`)
  }
}

export function checkAcceptFrom(hosts: readonly string[]): void {
  if (!Array.isArray(hosts) || !hosts.every(isIp)) {
    throw new TypeError(`acceptFrom must list IP addresses, got ${show(hosts)}`)
  }
}

export function checkMaxCalls(maxCalls: number): void {
  if (!isIntegerIn(maxCalls, 0, 0xffff)) {
    throw new RangeError(`maxCalls must be an integer from 0 to 65535, got ${show(maxCalls)}`)
  }
}
