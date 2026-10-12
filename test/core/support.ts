import type { CallMedia, CoreEvent, CoreInput, CoreOutput } from "../../src/core"
import { bob, bytes } from "../helpers"

export const negotiated: CallMedia = {
  remote: { host: "192.0.2.20", port: 4000 },
  codec: "PCMU",
  payloadType: 0,
  ptime: 20,
  direction: "sendrecv",
}

export const receive = (text: string): Extract<CoreInput, { type: "receive" }> => ({
  type: "receive",
  data: bytes(text),
  from: bob,
})

export const events = (outputs: CoreOutput[]): CoreEvent[] =>
  outputs.flatMap((output) => (output.type === "event" ? [output.event] : []))
