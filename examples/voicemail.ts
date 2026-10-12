import { writeFile } from "node:fs/promises"
import { connect, type RingingCall } from "usestraw"

const phone = await connect(process.env.SIP_URL)
console.log("Leave a message after the beep. Ctrl+C to stop.")
process.once("SIGINT", () => void phone.close({ drain: true }))

for await (const call of phone.incoming) void record(call)

async function record(ringing: RingingCall): Promise<void> {
  const call = await ringing.accept()
  if (!call.ok) return
  const { sampleRate } = call.audio
  const beep = Int16Array.from(
    { length: sampleRate / 2 },
    (_, index) => 6000 * Math.sin((2 * Math.PI * 660 * index) / sampleRate),
  )
  void call.audio.writable
    .getWriter()
    .write(beep)
    .catch(() => undefined)
  const limit = setTimeout(() => void call.end(), 60_000)
  const frames: Int16Array[] = []
  for await (const frame of call.audio.readable) frames.push(frame)
  clearTimeout(limit)
  const file = `voicemail-${Date.now()}.wav`
  await writeFile(file, wav(frames, sampleRate))
  const seconds = frames.reduce((total, frame) => total + frame.length, 0) / sampleRate
  console.log(`${seconds.toFixed(1)} s from ${call.from} in ${file}`)
}

function wav(frames: Int16Array[], sampleRate: number): Uint8Array {
  const size = frames.reduce((sum, frame) => sum + frame.byteLength, 0)
  const bytes = new Uint8Array(44 + size)
  const view = new DataView(bytes.buffer)
  const text = (at: number, value: string) => bytes.set(new TextEncoder().encode(value), at)
  text(0, "RIFF")
  view.setUint32(4, 36 + size, true)
  text(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, "data")
  view.setUint32(40, size, true)
  let at = 44
  for (const frame of frames) {
    for (const sample of frame) {
      view.setInt16(at, sample, true)
      at += 2
    }
  }
  return bytes
}
