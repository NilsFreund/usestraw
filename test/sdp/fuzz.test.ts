import { describe, expect, it } from "vitest"
import { answerOffer, isPlayable, readAnswer } from "../../src/sdp/negotiate"
import { parseSdp } from "../../src/sdp/parse"
import { writeMedia, writeSdp } from "../../src/sdp/write"
import { between, createRandom } from "../../src/simulation/random"
import { sdp } from "../helpers"
import { asterisk, freeswitch, ims, rfc4317, rtpengine, twoAudio, webrtc } from "./samples"

const SAMPLES = [freeswitch, asterisk, ims, webrtc, rtpengine, rfc4317, twoAudio, sdp()]
const SPICE = [
  "\r\n",
  "\n",
  " ",
  "=",
  ":",
  "/",
  "0",
  "65535",
  "99999",
  "a=",
  "m=",
  "c=IN IP4 ",
  "\x00",
  "é",
  " ",
]
const encoder = new TextEncoder()

function mutate(text: string, random: () => number): Uint8Array {
  let mutated = text
  for (let edit = between(random, 1, 4); edit > 0; edit--) {
    const at = between(random, 0, mutated.length)
    const spice = SPICE[between(random, 0, SPICE.length - 1)] ?? ""
    mutated =
      random() < 0.6
        ? mutated.slice(0, at) + spice + mutated.slice(at)
        : mutated.slice(0, at) + mutated.slice(at + between(random, 1, 8))
  }
  return encoder.encode(mutated)
}

describe("SDP under mutation", () => {
  it("never throws, and every answer it writes reads back as playable", () => {
    const random = createRandom(4566)
    const local = { host: "192.0.2.10", port: 40_000 }
    const local6 = { host: "2001:db8::10", port: 40_000 }
    let answered = 0
    for (let round = 0; round < 5000; round++) {
      const data = mutate(SAMPLES[round % SAMPLES.length] ?? "", random)
      const offer = parseSdp(data)
      const either = offer && (answerOffer(offer, local) ?? answerOffer(offer, local6))
      expect(isPlayable(data)).toBe(either !== undefined)
      if (!offer) continue
      readAnswer(offer, 0, local)
      const answer = answerOffer(offer, local)
      if (!answer) continue
      answered++
      expect(answer.media).toHaveLength(offer.media.length)
      const written = writeSdp(
        { id: "1", version: 1, host: local.host },
        writeMedia(local.host, answer.media),
      )
      const reread = parseSdp(written)
      expect(reread && readAnswer(reread, answer.index, local)).toMatchObject({
        remote: local,
        codec: answer.call.codec,
      })
    }
    expect(answered).toBeGreaterThan(1000)
  })
})
