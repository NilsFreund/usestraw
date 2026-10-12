import { answerOffer, createOffer, readAnswer, refuseLine } from "../../sdp/negotiate"
import { parseSdp } from "../../sdp/parse"
import type { CallMedia, MediaAddress, MediaDescription } from "../../sdp/types"
import { writeMedia, writeSdp } from "../../sdp/write"
import { type Random, randomInt } from "../../support/random"

export interface Media {
  readonly current: CallMedia | undefined
  offer(): Uint8Array
  answer(offer: Uint8Array): Uint8Array | undefined
  read(answer: Uint8Array): CallMedia | undefined
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
    get current() {
      return current
    },
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
      if (!answer || !media) return undefined
      current = media
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
    a.ptime === b.ptime &&
    a.direction === b.direction
  )
}
