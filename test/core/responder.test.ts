import { describe, expect, it } from "vitest"
import { type Output, parseMessage, type SipRequest } from "../../src"
import { createResponder } from "../../src/core/responder"
import { createRandom } from "../../src/simulation/random"
import { bob, parsedRequest } from "../helpers"

function request(method: string): SipRequest {
  return parsedRequest(
    [
      `${method} sip:alice@example.com SIP/2.0`,
      "Via: SIP/2.0/UDP 192.0.2.20:5070;branch=z9hG4bK1",
      "From: <sip:bob@example.com>;tag=b1",
      "To: <sip:alice@example.com>",
      "Call-ID: c1",
      `CSeq: 1 ${method}`,
      "",
      "",
    ].join("\r\n"),
  )
}

function statuses(outputs: Output[]) {
  return outputs.flatMap((output) => {
    if (output.type !== "send") return []
    const result = parseMessage(output.data)
    return result.ok && "status" in result.message ? [result.message.status] : []
  })
}

describe("createResponder (RFC 3261 §8.2.7)", () => {
  it("answers OPTIONS statelessly to the sent-by port and reports it", () => {
    const outputs = createResponder(createRandom(1)).respond(request("OPTIONS"), bob)
    expect(outputs[0]).toMatchObject({
      type: "event",
      event: { type: "answered", status: 200, from: bob },
    })
    expect(outputs[1]).toMatchObject({ type: "send", to: { ...bob, port: 5070 } })
    expect(statuses(outputs)).toStrictEqual([200])
  })

  it("swallows the ACK for its own rejection and passes other ACKs on", () => {
    const responder = createResponder(createRandom(1))
    const [, rejection] = responder.respond(request("INVITE"), bob)
    const parsed = rejection?.type === "send" ? parseMessage(rejection.data) : undefined
    const tag = parsed?.ok ? (parsed.message.to.params.get("tag") ?? "") : ""
    const ack = (value: string) => {
      const plain = request("ACK")
      return { ...plain, to: { ...plain.to, params: new Map([["tag", value]]) } }
    }
    expect(responder.respond(ack(tag), bob)).toStrictEqual([])
    expect(responder.respond(ack("dialog"), bob)).toMatchObject([
      { type: "event", event: { type: "request" } },
    ])
  })

  it("reports but does not send a reply above the size limit", () => {
    const name = "\t".repeat(32_700)
    const big = request("OPTIONS")
    const huge = {
      ...big,
      from: { ...big.from, displayName: name },
      to: { ...big.to, displayName: name },
    }
    const outputs = createResponder(createRandom(1)).respond(huge, bob)
    expect(outputs).toMatchObject([{ type: "event", event: { type: "answered", status: 200 } }])
  })
})
