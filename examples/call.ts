import { connect } from "usestraw"

const to = process.argv[2]
if (!to) throw new Error("Usage: node examples/call.ts <number>")

const phone = await connect(process.env.SIP_URL)
process.once("SIGINT", () => void phone.close())

const call = await phone.call(to, { timeout: 30_000 })

if (call.ok) {
  const writer = call.audio.writable.getWriter()
  try {
    await writer.write(melody([523, 659, 784, 1047], call.audio.sampleRate))
    await writer.close()
  } catch {
    console.log("The call ended early")
  }
  await call.end()
  console.log(`${call.to} heard ${call.audio.played} ms of music`)
} else {
  console.log(`Not answered: ${call.reason}`)
}

await phone.close()

function melody(notes: number[], sampleRate: number): Int16Array {
  const note = sampleRate / 4
  return Int16Array.from({ length: notes.length * note }, (_, index) => {
    const hz = notes[Math.floor(index / note)] ?? 0
    return 6000 * Math.sin((2 * Math.PI * hz * index) / sampleRate)
  })
}
