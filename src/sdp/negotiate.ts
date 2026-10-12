import { SAMPLE_RATE, STATIC_CODECS } from "../rtp/g711"
import { isIntegerIn } from "../support/integer"
import { familyOf, isUnspecified } from "../support/ip"
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
  readonly prefer?: Codec
}

export interface Negotiated {
  readonly media: readonly MediaDescription[]
  readonly index: number
  readonly call: CallMedia
}

const CODECS = [...STATIC_CODECS]
const PROTOCOLS: ReadonlySet<string> = new Set(["RTP/AVP", "RTP/AVPF"])
const PTIME = 20

export function createOffer(local: MediaAddress, options: OfferOptions = {}): MediaDescription {
  const { prefer } = options
  const codecs = [
    ...CODECS.filter(([, name]) => name === prefer),
    ...CODECS.filter(([, name]) => name !== prefer),
  ]
  return {
    kind: "audio",
    port: local.port,
    protocol: "RTP/AVP",
    formats: codecs.map(([type]) => String(type)),
    rtpmap: new Map<number, RtpMap>(
      codecs.map(([type, name]) => [type, { name, rate: SAMPLE_RATE }]),
    ),
    ptime: PTIME,
    direction: "sendrecv",
  }
}

// RFC 3264 §6: one answer line per offered line in order; the first audio line we can play wins
export function answerOffer(
  offer: SessionDescription,
  local: MediaAddress,
  options: OfferOptions = {},
): Negotiated | undefined {
  const { prefer } = options
  let chosen: { readonly call: CallMedia; readonly index: number } | undefined
  const media = offer.media.map((line, index) => {
    const call = chosen ? undefined : remoteMedia(offer, line, local, prefer)
    if (!call) return refuseLine(line)
    chosen = { call, index }
    return answerLine(line, call, local)
  })
  return chosen && { media, ...chosen }
}

// RFC 3264 §6.1: the answer line at the index of our audio line tells how to send
export function readAnswer(
  answer: SessionDescription,
  index: number,
  local: MediaAddress,
): CallMedia | undefined {
  const line = answer.media[index]
  return line && remoteMedia(answer, line, local)
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
  }
}

export function payloadTypeOf(format: string): number | undefined {
  return /^(?:0|[1-9]\d{0,2})$/.test(format) && Number(format) <= 127 ? Number(format) : undefined
}

function remoteMedia(
  sdp: SessionDescription,
  line: MediaDescription,
  local?: MediaAddress,
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
  const theirs = isUnspecified(connection.address) ? deaf(offered) : offered
  return {
    remote: { host: connection.address, port: line.port },
    codec: choice.codec,
    payloadType: choice.type,
    ptime: line.ptime !== undefined && isIntegerIn(line.ptime, 10, 120) ? line.ptime : PTIME,
    direction: reverse(theirs),
  }
}

// RFC 4733 events are not answered until Straw can hear them, so carriers keep tones in the audio
function answerLine(
  line: MediaDescription,
  call: CallMedia,
  local: MediaAddress,
): MediaDescription {
  const { payloadType, codec, direction } = call
  return {
    kind: "audio",
    port: local.port,
    protocol: line.protocol,
    formats: [String(payloadType)],
    rtpmap: new Map([[payloadType, { name: codec, rate: SAMPLE_RATE }]]),
    ptime: PTIME,
    direction,
  }
}

function codecOf(line: MediaDescription, type: number): Codec | undefined {
  const map = line.rtpmap.get(type)
  if (!map) return STATIC_CODECS.get(type)
  const name = map.name.toUpperCase()
  const mono = map.rate === SAMPLE_RATE && (map.channels ?? 1) === 1
  return mono && (name === "PCMU" || name === "PCMA") ? name : undefined
}

function reverse(direction: MediaDirection): MediaDirection {
  if (direction === "sendonly") return "recvonly"
  if (direction === "recvonly") return "sendonly"
  return direction
}

// What a side still does once it receives nothing
function deaf(direction: MediaDirection): MediaDirection {
  return direction === "sendrecv" || direction === "sendonly" ? "sendonly" : "inactive"
}
