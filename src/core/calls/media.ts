import { answerOffer, createOffer, readAnswer, refuseLine } from "../../sdp/negotiate"
import { parseSdp } from "../../sdp/parse"
import type { CallMedia, MediaAddress, MediaDescription } from "../../sdp/types"
import { writeMedia, writeSdp } from "../../sdp/write"
import { type Random, randomInt } from "../../support/random"
import type { RemoteDescription } from "../types"

/** What call events show of the session: the agreed RTP media, or the far end's SDP for the app. */
export interface Shown {
  readonly media?: CallMedia
  readonly description?: RemoteDescription
}

export interface Media {
  offer(): Uint8Array
  answer(offer: Uint8Array): Uint8Array | undefined
  read(answer: Uint8Array): boolean
  shown(type: "pranswer" | "answer"): Shown
  // Only for the app's own SDP: what it made for the far end's offer, or as its own for an empty one
  use?(sdp: string, offer: Uint8Array): Uint8Array
}

export type MediaSetup = MediaAddress | { readonly sdp: string }

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export function mediaFor(setup: MediaSetup, random: Random): Media {
  return "sdp" in setup ? createAppMedia(setup.sdp) : createMedia(setup, random)
}

// RFC 3264 §8: our o= keeps its id, a new version only on change, and every line keeps its place
export function createMedia(local: MediaAddress, random: Random): Media {
  const id = String(randomInt(random, 2 ** 31))
  let version = 0
  let last: string | undefined
  let lines: readonly MediaDescription[] = []
  let index = 0
  let current: CallMedia | undefined

  function describe(media: readonly MediaDescription[]): Uint8Array {
    lines = media
    const body = writeMedia(local.host, media)
    if (body !== last) version += 1
    last = body
    return writeSdp({ id, version, host: local.host }, body)
  }

  return {
    shown: () => (current ? { media: current } : {}),
    offer: () => {
      const prefer = current?.codec
      const ours = createOffer(local, prefer ? { prefer } : {})
      const media =
        lines.length === 0
          ? [ours]
          : lines.map((line, at) => (at === index ? ours : refuseLine(line)))
      return describe(media)
    },
    answer: (data) => {
      const offer = parseSdp(data)
      const negotiated =
        offer && answerOffer(offer, local, current ? { prefer: current.codec } : {})
      if (!offer || !negotiated) return undefined
      current = negotiated.call
      index = negotiated.index
      return describe(negotiated.media)
    },
    read: (data) => {
      const answer = parseSdp(data)
      const media = answer && readAnswer(answer, index, local)
      if (!answer || !media) return false
      current = media
      return true
    },
  }
}

// WebRTC makes its own SDP, so the core only carries it: the same offer again gets the same answer
export function createAppMedia(local: string): Media {
  let ours = encoder.encode(local)
  let first = true
  let answered: string | undefined
  let heard: string | undefined
  return {
    shown: (type) => (heard === undefined ? {} : { description: { type, sdp: heard } }),
    offer: () => ours,
    answer: (data) => {
      const text = sdpOf(data)
      if (text === undefined || !(first || answered === text)) return undefined
      first = false
      answered = text
      return ours
    },
    read: (data) => {
      first = false
      heard = sdpOf(data)
      return heard !== undefined
    },
    use: (sdp, offer) => {
      first = false
      answered = sdpOf(offer)
      ours = encoder.encode(sdp)
      return ours
    },
  }
}

// RFC 4566 §5: SDP is UTF-8 text that starts with its version and never holds a NUL
export function sdpOf(data: Uint8Array): string | undefined {
  try {
    const text = decoder.decode(data)
    return /^v=0\r?\n/.test(text) && !text.includes("\0") ? text : undefined
  } catch {
    return undefined
  }
}

export function sameShown(a: Shown, b: Shown): boolean {
  if (a.media && b.media) return sameMedia(a.media, b.media)
  return a.media === b.media
}

export function sameMedia(a: CallMedia, b: CallMedia): boolean {
  return (
    a.remote.host === b.remote.host &&
    a.remote.port === b.remote.port &&
    a.payloadType === b.payloadType &&
    a.codec === b.codec &&
    a.ptime === b.ptime &&
    a.direction === b.direction
  )
}
