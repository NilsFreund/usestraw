import { connect, type RingingCall } from "usestraw"

const SPEAKING = 800
const END_OF_TURN = 35
const BARGE_IN = 4

const phone = await connect(process.env.SIP_URL)
console.log("Call me and say something. Talk over me and I stop. Ctrl+C to stop.")
process.once("SIGINT", () => void phone.close({ drain: true }))

for await (const call of phone.incoming) void parrot(call)

async function parrot(ringing: RingingCall): Promise<void> {
  const call = await ringing.accept()
  if (!call.ok) return
  const writer = call.audio.writable.getWriter()
  let turn: Int16Array[] = []
  let loud = 0
  let quiet = 0
  for await (const frame of call.audio.readable) {
    const speaking = level(frame) > SPEAKING
    loud = speaking ? loud + 1 : 0
    quiet = speaking ? 0 : quiet + 1
    if (loud === BARGE_IN) call.audio.clear()
    if (speaking || turn.length > 0) turn.push(frame)
    if (quiet === END_OF_TURN) {
      const words = turn.slice(0, -END_OF_TURN)
      if (words.length > 10) void writer.write(join(words)).catch(() => undefined)
      turn = []
    }
  }
  console.log(`${call.from} hung up after hearing ${Math.round(call.audio.played / 1000)} s`)
}

function level(frame: Int16Array): number {
  return Math.sqrt(frame.reduce((sum, sample) => sum + sample * sample, 0) / frame.length)
}

function join(frames: Int16Array[]): Int16Array {
  const joined = new Int16Array(frames.reduce((total, frame) => total + frame.length, 0))
  let offset = 0
  for (const frame of frames) {
    joined.set(frame, offset)
    offset += frame.length
  }
  return joined
}
