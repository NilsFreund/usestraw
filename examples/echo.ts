import { connect } from "usestraw"

const phone = await connect(process.env.SIP_URL)
console.log("Call me and you will hear yourself. Ctrl+C to stop.")

process.once("SIGINT", () => {
  void phone.close({ drain: true, signal: AbortSignal.timeout(10_000) })
})

for await (const call of phone.incoming) {
  console.log(`${call.callerName ?? call.from} is calling`)
  void call.accept(new TransformStream())
  void call.ended.then(({ by, reason }) => console.log(`${call.from}: ${reason} by ${by}`))
}
