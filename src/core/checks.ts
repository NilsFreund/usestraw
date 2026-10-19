import { isCallId, isStrictCallId } from "../message/fields/call-id"
import { isRequestUri, isUri, splitSipUri } from "../message/fields/uri"
import { hasLineBreak, isText, show } from "../message/syntax"
import type { MediaAddress } from "../sdp/types"
import { isIntegerIn } from "../support/integer"
import { familyOf, isIp, isUnspecified, parseRange, type Range } from "../support/ip"
import { isAddress, isWebSocket, type TransportAddress } from "../transport/address"
import { isInstanceId } from "./ids"
import type { AppMedia, Credentials, LocalMedia } from "./types"

export function checkAddress(address: TransportAddress): void {
  if (!isAddress(address)) throw new TypeError(`Invalid address ${show(address)}`)
}

// A WebSocket only ever knows the server by name, as a browser does
export function checkSource(from: TransportAddress): void {
  checkAddress(from)
  if (!isIp(from.host) && !isWebSocket(from.transport)) {
    throw new TypeError(`The source must be an IP address, got ${show(from.host)}`)
  }
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

export function checkCallId(callId: string): void {
  if (!isStrictCallId(callId) || callId.length > 256) {
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
export function checkMedia(media: LocalMedia | AppMedia, fallback: string): MediaAddress {
  if (typeof media === "object" && media !== null && "sdp" in media) {
    throw new TypeError('{ sdp } needs a core with media: "sdp"')
  }
  if (typeof media !== "object" || media === null) {
    throw new TypeError(`Invalid media ${show(media)}`)
  }
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

const MAX_SDP = 32_768
const encoder = new TextEncoder()

// The app's SDP goes out as it is, so it has to be SDP and fit a message
export function checkAppMedia(media: LocalMedia | AppMedia): string {
  const sdp = typeof media === "object" && media !== null && "sdp" in media ? media.sdp : undefined
  if (typeof sdp !== "string" || !/^v=0\r?\n/.test(sdp) || sdp.includes("\0")) {
    throw new TypeError(`With media: "sdp", calls take { sdp } with an SDP, got ${show(media)}`)
  }
  const size = encoder.encode(sdp).length
  if (size > MAX_SDP) {
    throw new RangeError(`An SDP must be at most ${MAX_SDP} bytes, got ${size}`)
  }
  return sdp
}

export function checkRejection(status: number): void {
  if (!isIntegerIn(status, 400, 699)) {
    throw new RangeError(`A call can be rejected with 400 to 699, got ${show(status)}`)
  }
}

export function parseAcceptFrom(ranges: readonly string[]): Range[] {
  const valid = Array.isArray(ranges)
  const parsed = valid
    ? Array.from(ranges, (range: unknown) =>
        typeof range === "string" ? parseRange(range) : undefined,
      )
    : []
  if (!valid || parsed.includes(undefined)) {
    throw new TypeError(`acceptFrom must list IP addresses or CIDR ranges, got ${show(ranges)}`)
  }
  return parsed.filter((range) => range !== undefined)
}

export function checkInstance(instance: string): void {
  if (typeof instance !== "string" || !isInstanceId(instance)) {
    throw new TypeError(`instance must be a urn:uuid: URN, got ${show(instance)}`)
  }
}

export const MAX_CALLS = 100

export function checkMaxCalls(maxCalls: number): void {
  if (!isIntegerIn(maxCalls, 0, 0xffff)) {
    throw new RangeError(`maxCalls must be an integer from 0 to 65535, got ${show(maxCalls)}`)
  }
}
