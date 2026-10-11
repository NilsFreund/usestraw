import type { Random } from "../core/types"
import { isPrivate, sameHost } from "../sdp/address"
import { STATIC_CODECS } from "../sdp/negotiate"
import type { CallMedia, Codec, MediaAddress } from "../sdp/types"
import { decodeG711, encodeG711, SAMPLES_PER_MS } from "./g711"
import { createJitter } from "./jitter"
import { type RtpPacket, readRtp, writeRtp } from "./packet"

export type MediaInput =
  | { readonly type: "packet"; readonly data: Uint8Array; readonly from: MediaAddress }
  | { readonly type: "audio"; readonly pcm: Int16Array }
  | { readonly type: "clear" }
  | { readonly type: "media"; readonly media: CallMedia }
  | { readonly type: "timeout" }

export type MediaOutput =
  | { readonly type: "send"; readonly data: Uint8Array; readonly to: MediaAddress }
  | { readonly type: "frame"; readonly pcm: Int16Array<ArrayBuffer> }
  | { readonly type: "silent" }

export interface MediaEngine {
  readonly queued: number
  readonly played: number
  handle(input: MediaInput, now: number): MediaOutput[]
  nextDeadline(): number | undefined
}

const FRAME = 20
const MAX_LAG = 5
const LEARN = 2000
const PROBATION = 3
const MAX_PAYLOAD = 120 * SAMPLES_PER_MS
const SILENCE_LIMIT = 60_000

interface Candidate {
  readonly from: MediaAddress
  readonly ssrc: number
  readonly sequence: number
  readonly count: number
}

// The media of one call: G.711 over RTP sent at the far end's ptime with silence when the app has
// nothing to say, and a steady 20 ms frame of what we hear, silence included
export function createMediaEngine(random: Random): MediaEngine {
  const jitter = createJitter()
  const ssrc = randomNumber(random, 2 ** 32)
  const base = randomNumber(random, 2 ** 32)
  let sequence = randomNumber(random, 2 ** 16)
  let media: CallMedia | undefined
  let latched: MediaAddress | undefined
  let candidate: Candidate | undefined
  let learnUntil: number | undefined
  let origin: number | undefined
  let sendAt: number | undefined
  let sentAt: number | undefined
  let playAt: number | undefined
  let queue: Int16Array[] = []
  let queued = 0
  let played = 0
  let heardAt: number | undefined

  function handle(input: MediaInput, now: number): MediaOutput[] {
    switch (input.type) {
      case "packet":
        receive(input.data, input.from, now)
        return []
      case "audio":
        queue.push(input.pcm)
        queued += input.pcm.length
        return []
      case "clear":
        queue = []
        queued = 0
        return []
      case "media":
        update(input.media, now)
        return []
      case "timeout":
        return [...play(now), ...send(now), ...silence(now)]
    }
  }

  function update(next: CallMedia, now: number): void {
    if (!media || !same(next.remote, media.remote)) {
      latched = undefined
      candidate = undefined
      learnUntil = undefined
    }
    media = next
    heardAt = next.direction === "sendrecv" ? now : undefined
    const sending = next.direction === "sendrecv" || next.direction === "sendonly"
    if (!sending) sendAt = undefined
    else sendAt ??= now
    playAt ??= now
  }

  // RFC 3550 §A.1 and the RTP Bleed lesson: the signalled address always wins, and another one
  // is learnt only from a NATed (private) signalled address in the 2 s after the first packet, or
  // from another port of the signalled host
  function receive(data: Uint8Array, from: MediaAddress, now: number): void {
    if (!media || from.port === 0) return
    const packet = readRtp(data)
    if (!packet) return
    const signalled = same(from, media.remote)
    const known = latched !== undefined && same(from, latched)
    if (signalled) {
      latched = undefined
      learnUntil = Number.NEGATIVE_INFINITY
    } else if (!known && !learn(from, packet, media.remote, now)) return
    if (heardAt !== undefined) heardAt = now
    const codec = codecOf(packet.payloadType)
    if (!codec || packet.payload.length === 0 || packet.payload.length > MAX_PAYLOAD) return
    const pcm = decodeG711(codec, packet.payload)
    jitter.push(
      { ssrc: packet.ssrc, sequence: packet.sequence, timestamp: packet.timestamp, pcm },
      now,
    )
  }

  function learn(
    from: MediaAddress,
    packet: RtpPacket,
    remote: MediaAddress,
    now: number,
  ): boolean {
    const nearby = sameHost(from.host, remote.host)
    if (!nearby && !isPrivate(remote.host)) return false
    learnUntil ??= now + LEARN
    if (now > learnUntil) return false
    const count = candidate && continues(candidate, from, packet) ? candidate.count + 1 : 1
    candidate = { from, ssrc: packet.ssrc, sequence: packet.sequence, count }
    if (count < PROBATION && !nearby) return false
    latched = { host: from.host, port: from.port }
    learnUntil = Number.NEGATIVE_INFINITY
    return true
  }

  function silence(now: number): MediaOutput[] {
    if (heardAt === undefined || now - heardAt < SILENCE_LIMIT) return []
    heardAt = undefined
    return [{ type: "silent" }]
  }

  function codecOf(payloadType: number): Codec | undefined {
    if (media && payloadType === media.payloadType) return media.codec
    return STATIC_CODECS.get(payloadType)
  }

  function play(now: number): MediaOutput[] {
    const outputs: MediaOutput[] = []
    if (playAt === undefined) return outputs
    if (now - playAt > MAX_LAG * FRAME) playAt = now
    for (; playAt <= now; playAt += FRAME) {
      outputs.push({ type: "frame", pcm: jitter.read(FRAME * SAMPLES_PER_MS, playAt) })
    }
    return outputs
  }

  function take(samples: number): Int16Array {
    const frame = new Int16Array(samples)
    let filled = 0
    for (let head = queue[0]; head && filled < samples; head = queue[0]) {
      const part = head.subarray(0, samples - filled)
      frame.set(part, filled)
      filled += part.length
      if (part.length === head.length) queue.shift()
      else queue[0] = head.subarray(part.length)
    }
    queued -= filled
    played += filled
    return frame
  }

  // RFC 3550 §5.1 and RFC 3551 §4.1: the timestamp follows the clock across pauses, and the first
  // packet after one carries the marker
  function send(now: number): MediaOutput[] {
    const outputs: MediaOutput[] = []
    if (!media || sendAt === undefined) return outputs
    const step = Math.max(10, media.ptime)
    const samples = step * SAMPLES_PER_MS
    if (now - sendAt > MAX_LAG * step) sendAt = now
    const to = latched ?? media.remote
    for (; sendAt <= now; sendAt += step) {
      origin ??= sendAt
      const timestamp = base + Math.round((sendAt - origin) * SAMPLES_PER_MS)
      const marker = sentAt === undefined || sendAt - sentAt > step
      const payload = encodeG711(media.codec, take(samples))
      const packet = { marker, payloadType: media.payloadType, sequence, timestamp, ssrc, payload }
      outputs.push({ type: "send", data: writeRtp(packet), to })
      sequence += 1
      sentAt = sendAt
    }
    return outputs
  }

  return {
    get queued() {
      return queued
    },
    get played() {
      return played
    },
    handle,
    nextDeadline: () => {
      const times = [sendAt, playAt].filter((at) => at !== undefined)
      return times.length === 0 ? undefined : Math.min(...times)
    },
  }
}

function continues(candidate: Candidate, from: MediaAddress, packet: RtpPacket): boolean {
  const { ssrc, sequence } = candidate
  return (
    same(from, candidate.from) &&
    packet.ssrc === ssrc &&
    packet.sequence === (sequence + 1) % 65_536
  )
}

function same(a: MediaAddress, b: MediaAddress): boolean {
  return a.port === b.port && sameHost(a.host, b.host)
}

function randomNumber(random: Random, range: number): number {
  return Math.min(range - 1, Math.floor(random() * range))
}
