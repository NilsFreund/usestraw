import { isIntegerIn } from "../support/integer"
import { familyOf, isUnspecified } from "./address"
import { parseSdp } from "./parse"
import type {
  CallMedia,
  Codec,
  MediaAddress,
  MediaDescription,
  MediaDirection,
  RtpMap,
  SessionDescription,
} from "./types"

export interface OfferOptions {
  readonly want?: MediaDirection
  readonly prefer?: Codec
  readonly dtmf?: number
}

export interface Negotiated {
  readonly media: readonly MediaDescription[]
  readonly index: number
  readonly call: CallMedia
}

const CODECS: readonly [number, Codec][] = [
  [0, "PCMU"],
  [8, "PCMA"],
]
export const STATIC_CODECS: ReadonlyMap<number, Codec> = new Map(CODECS)
const EVENTS: RtpMap = { name: "telephone-event", rate: 8000 }
const PROTOCOLS: ReadonlySet<string> = new Set(["RTP/AVP", "RTP/AVPF"])
const DTMF = 101
const PTIME = 20

export function createOffer(local: MediaAddress, options: OfferOptions = {}): MediaDescription {
  const { want = "sendrecv", prefer, dtmf = DTMF } = options
  const codecs = [
    ...CODECS.filter(([, name]) => name === prefer),
    ...CODECS.filter(([, name]) => name !== prefer),
  ]
  return {
    kind: "audio",
    port: local.port,
    protocol: "RTP/AVP",
    formats: [...codecs.map(([type]) => String(type)), String(dtmf)],
    rtpmap: new Map<number, RtpMap>([
      ...codecs.map(([type, name]) => [type, { name, rate: 8000 }] as const),
      [dtmf, EVENTS],
    ]),
    fmtp: new Map([[dtmf, "0-16"]]),
    ptime: PTIME,
    direction: want,
  }
}

// RFC 3264 §6: one answer line per offered line in order; the first audio line we can play wins
export function answerOffer(
  offer: SessionDescription,
  local: MediaAddress,
  options: Omit<OfferOptions, "dtmf"> = {},
): Negotiated | undefined {
  const { want = "sendrecv", prefer } = options
  let chosen: { readonly call: CallMedia; readonly index: number } | undefined
  const media = offer.media.map((line, index) => {
    const call = chosen ? undefined : remoteMedia(offer, line, local, want, prefer)
    if (!call) return refuseLine(line)
    chosen = { call, index }
    return accept(line, call, local)
  })
  return chosen && { media, ...chosen }
}

// RFC 3264 §6.1: the answer line at the index of our audio line tells how to send
export function readAnswer(
  answer: SessionDescription,
  index: number,
  local: MediaAddress,
  want: MediaDirection = "sendrecv",
): CallMedia | undefined {
  const line = answer.media[index]
  return line && remoteMedia(answer, line, local, want)
}

export function isPlayable(data: Uint8Array): boolean {
  const offer = parseSdp(data)
  return offer?.media.some((line) => remoteMedia(offer, line)) ?? false
}

// RFC 3264 §6: a refused stream keeps its line with port 0 and one of the offered formats
export function refuseLine(line: MediaDescription): MediaDescription {
  const { kind, protocol, formats } = line
  return {
    kind,
    port: 0,
    protocol,
    formats: formats.slice(0, 1),
    rtpmap: new Map(),
    fmtp: new Map(),
  }
}

export function payloadTypeOf(format: string): number | undefined {
  return /^(?:0|[1-9]\d{0,2})$/.test(format) && Number(format) <= 127 ? Number(format) : undefined
}

function remoteMedia(
  sdp: SessionDescription,
  line: MediaDescription,
  local?: MediaAddress,
  want: MediaDirection = "sendrecv",
  prefer?: Codec,
): CallMedia | undefined {
  const connection = line.connection ?? sdp.connection
  const family = connection && familyOf(connection.address)
  const rtp = line.kind === "audio" && line.port !== 0 && PROTOCOLS.has(line.protocol.toUpperCase())
  if (!rtp || !connection || !family || family !== connection.family) return undefined
  if (local && familyOf(local.host) !== family) return undefined
  const codecs = line.formats.flatMap((format) => {
    const type = payloadTypeOf(format)
    const codec = type === undefined ? undefined : codecOf(line, type)
    return type !== undefined && codec ? [{ type, codec }] : []
  })
  const choice = codecs.find((entry) => entry.codec === prefer) ?? codecs[0]
  if (!choice) return undefined
  const offered = line.direction ?? sdp.direction ?? "sendrecv"
  // RFC 3264 §8.4: a connection address of 0.0.0.0 is the old way of saying "do not send to me"
  const theirs = isUnspecified(connection.address) ? meet(offered, "sendonly") : offered
  const dtmf = line.formats.map(payloadTypeOf).find((type) => isEvents(line, type))
  return {
    remote: { host: connection.address, port: line.port },
    codec: choice.codec,
    payloadType: choice.type,
    ...(dtmf === undefined ? {} : { dtmf }),
    ptime: line.ptime !== undefined && isIntegerIn(line.ptime, 10, 120) ? line.ptime : PTIME,
    direction: meet(reverse(theirs), want),
  }
}

// RFC 4733 §7.1.1: without an fmtp the offer means events 0-15, and only a plain event list is echoed
function accept(line: MediaDescription, call: CallMedia, local: MediaAddress): MediaDescription {
  const { payloadType, codec, dtmf, direction } = call
  const rtpmap = new Map<number, RtpMap>([[payloadType, { name: codec, rate: 8000 }]])
  const fmtp = new Map<number, string>()
  if (dtmf !== undefined) {
    const events = line.fmtp.get(dtmf) ?? ""
    rtpmap.set(dtmf, EVENTS)
    fmtp.set(dtmf, /^[\d,-]{1,64}$/.test(events) ? events : "0-15")
  }
  const formats = [...rtpmap.keys()].map(String)
  const protocol = line.protocol
  return {
    kind: "audio",
    port: local.port,
    protocol,
    formats,
    rtpmap,
    fmtp,
    ptime: PTIME,
    direction,
  }
}

function codecOf(line: MediaDescription, type: number): Codec | undefined {
  const map = line.rtpmap.get(type)
  if (!map) return STATIC_CODECS.get(type)
  const name = map.name.toUpperCase()
  const mono = map.rate === 8000 && (map.channels ?? 1) === 1
  return mono && (name === "PCMU" || name === "PCMA") ? name : undefined
}

function isEvents(line: MediaDescription, type: number | undefined): type is number {
  const map = type === undefined ? undefined : line.rtpmap.get(type)
  return map?.name.toLowerCase() === "telephone-event" && map.rate === 8000
}

function reverse(direction: MediaDirection): MediaDirection {
  if (direction === "sendonly") return "recvonly"
  if (direction === "recvonly") return "sendonly"
  return direction
}

function meet(a: MediaDirection, b: MediaDirection): MediaDirection {
  const send = sends(a) && sends(b)
  const receive = receives(a) && receives(b)
  if (send && receive) return "sendrecv"
  if (send) return "sendonly"
  return receive ? "recvonly" : "inactive"
}

function sends(direction: MediaDirection): boolean {
  return direction === "sendrecv" || direction === "sendonly"
}

function receives(direction: MediaDirection): boolean {
  return direction === "sendrecv" || direction === "recvonly"
}
