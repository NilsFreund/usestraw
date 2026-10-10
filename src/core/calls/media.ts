import { answerOffer, createOffer, payloadTypeOf, readAnswer, refuse } from "../../sdp/negotiate"
import { parseSdp } from "../../sdp/parse"
import type { CallMedia, MediaAddress, MediaDescription } from "../../sdp/types"
import { writeMedia, writeSdp } from "../../sdp/write"
import type { Random } from "../types"

export interface Media {
  readonly current: CallMedia | undefined
  offer(): Uint8Array
  answer(offer: Uint8Array): Uint8Array | undefined
  read(answer: Uint8Array): CallMedia | undefined
}

const DTMF = [101, ...Array.from({ length: 32 }, (_, index) => 96 + index)]

// RFC 3264 §8: our origin keeps its id, its version moves only when our description changes, and every
// offer keeps the session's lines in place with the payload types both sides already use
export function createMedia(local: MediaAddress, random: Random): Media {
  const id = String(Math.floor(random() * 2 ** 31))
  let version = 0
  let last: string | undefined
  let lines: readonly MediaDescription[] = []
  let index = 0
  let taken: ReadonlySet<number> = new Set()
  let current: CallMedia | undefined

  function describe(media: readonly MediaDescription[]): Uint8Array {
    lines = media
    const body = writeMedia(local.host, media)
    if (body !== last) version += 1
    last = body
    return writeSdp({ id, version, host: local.host }, body)
  }

  function remember(line: MediaDescription | undefined): void {
    taken = new Set(line?.formats.map(payloadTypeOf).filter((type) => type !== undefined))
  }

  return {
    get current() {
      return current
    },
    offer: () => {
      const dtmf = current?.dtmf ?? DTMF.find((type) => !taken.has(type))
      const prefer = current?.codec
      const ours = createOffer(local, { ...(prefer ? { prefer } : {}), ...(dtmf ? { dtmf } : {}) })
      const media =
        lines.length === 0 ? [ours] : lines.map((line, at) => (at === index ? ours : refuse(line)))
      return describe(media)
    },
    answer: (data) => {
      const offer = parseSdp(data)
      const negotiated =
        offer && answerOffer(offer, local, current ? { prefer: current.codec } : {})
      if (!offer || !negotiated) return undefined
      current = negotiated.call
      index = negotiated.index
      remember(offer.media[index])
      return describe(negotiated.media)
    },
    read: (data) => {
      const answer = parseSdp(data)
      const media = answer && readAnswer(answer, index, local)
      if (!answer || !media) return undefined
      current = media
      remember(answer.media[index])
      return media
    },
  }
}

export function sameMedia(a: CallMedia, b: CallMedia): boolean {
  return (
    a.remote.host === b.remote.host &&
    a.remote.port === b.remote.port &&
    a.payloadType === b.payloadType &&
    a.codec === b.codec &&
    a.dtmf === b.dtmf &&
    a.ptime === b.ptime &&
    a.direction === b.direction
  )
}
