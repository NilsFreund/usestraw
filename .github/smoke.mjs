// Runs the packed usestraw against a tiny registrar on loopback, as an app would install it
import assert from "node:assert/strict"
import { createSocket } from "node:dgram"
import { createRequire } from "node:module"
import * as straw from "usestraw"
import * as core from "usestraw/core"
import * as node from "usestraw/node"

const { version } = createRequire(import.meta.url)("usestraw/package.json")
assert.deepEqual(Object.keys(straw).sort(), ["ConnectError", "connect"])
assert.deepEqual(Object.keys(node).sort(), Object.keys(straw).sort())
assert.equal(typeof core.replay, "function")

const server = createSocket("udp4")
await new Promise((resolve) => server.bind(0, "127.0.0.1", resolve))
const methods = []
server.on("message", (data, from) => {
  const lines = data.toString().split("\r\n\r\n")[0].split("\r\n")
  if (lines[0].startsWith("SIP/2.0")) return
  const method = lines[0].split(" ")[0]
  methods.push(method)
  if (method === "ACK") return
  const echoed = lines.filter((line) => /^(via|from|call-id|cseq|contact):/i.test(line))
  const to = lines.find((line) => /^to:/i.test(line))
  const status = method === "INVITE" ? "486 Busy Here" : "200 OK"
  const reply = [`SIP/2.0 ${status}`, ...echoed, `${to};tag=smoke`, "Content-Length: 0", "", ""]
  server.send(reply.join("\r\n"), from.port, from.address)
})

const phone = await straw.connect(`udp://alice@127.0.0.1:${server.address().port}`)
assert.equal(phone.status, "online")
const call = await phone.call("bob", { timeout: 5000 })
assert.equal(call.reason, "busy")
assert.equal(core.replay(phone.trace ?? "").ok, true)
await phone.close()
assert.equal(phone.status, "closed")
server.close()

const runtime = typeof Bun === "undefined" ? `Node ${process.version}` : `Bun ${Bun.version}`
console.log(`usestraw ${version} on ${runtime}: ${methods.join(" ")}`)
