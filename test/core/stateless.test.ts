import { describe, expect, it } from "vitest"
import type { SipRequest } from "../../src"
import { createStateless } from "../../src/core/stateless"
import { createRandom } from "../../src/simulation/random"
import { serverKey } from "../../src/transaction/keys"
import { request } from "../transaction/support"

const rejection = { status: 405, reason: "Method Not Allowed", headers: [] }

function acked(ack: SipRequest, tag: string | null | undefined): SipRequest {
  return { ...ack, to: { ...ack.to, params: new Map([["tag", tag ?? ""]]) } }
}

describe("createStateless (RFC 3261 §8.2.7)", () => {
  it("builds the rejection with the given status, reason and headers", () => {
    const headers = [{ name: "Allow", value: "OPTIONS" }]
    const reply = createStateless(createRandom(1)).reply(request("INVITE"), {
      ...rejection,
      headers,
    })
    expect(reply).toMatchObject({ status: 405, reason: "Method Not Allowed", headers })
  })

  it("derives the same To tag for the same request", () => {
    const stateless = createStateless(createRandom(1))
    const tag = () => stateless.reply(request("INVITE"), rejection).to.params.get("tag")
    expect(tag()).toMatch(/^[0-9a-f]{16}$/)
    expect(tag()).toBe(tag())
  })

  it("derives different tags for different requests", () => {
    const stateless = createStateless(createRandom(1))
    const tag = (branch: string) =>
      stateless.reply(request("INVITE", branch), rejection).to.params.get("tag")
    expect(tag("z9hG4bK1")).not.toBe(tag("z9hG4bK2"))
  })

  it("signs only the first 512 bytes of a huge transaction key", () => {
    const stateless = createStateless(createRandom(1))
    const tag = (branch: string) =>
      stateless.reply(request("INVITE", branch), rejection).to.params.get("tag")
    const long = `z9hG4bK${"x".repeat(600)}`
    expect(tag(`${long}a`)).toBe(tag(`${long}b`))
    expect(tag(`z9hG4bK${"x".repeat(400)}a`)).not.toBe(tag(`z9hG4bK${"x".repeat(400)}b`))
  })

  it("salts tags per instance", () => {
    const tag = (seed: number) =>
      createStateless(createRandom(seed)).reply(request("INVITE"), rejection).to.params.get("tag")
    expect(tag(1)).not.toBe(tag(2))
  })

  it("keeps an existing To tag", () => {
    const inDialog = acked(request("BYE"), "dialog")
    const reply = createStateless(createRandom(1)).reply(inDialog, rejection)
    expect(reply.to.params.get("tag")).toBe("dialog")
  })

  it("recognizes the ACK for its own rejection", () => {
    const stateless = createStateless(createRandom(1))
    const tag = stateless.reply(request("INVITE"), rejection).to.params.get("tag")
    expect(stateless.acknowledges(acked(request("ACK"), tag))).toBe(true)
    expect(stateless.acknowledges(acked(request("ACK"), "other"))).toBe(false)
    expect(stateless.acknowledges(request("ACK"))).toBe(false)
  })

  it("recognizes the ACK for a rejected RFC 2543 INVITE", () => {
    const stateless = createStateless(createRandom(1))
    const tag = stateless.reply(request("INVITE", "legacy"), rejection).to.params.get("tag")
    const ack = acked(request("ACK", "legacy"), tag)
    expect(serverKey(ack)).not.toBe(serverKey(request("INVITE", "legacy")))
    expect(stateless.acknowledges(ack)).toBe(true)
  })

  it("does not recognize the ACK of another instance", () => {
    const tag = createStateless(createRandom(1))
      .reply(request("INVITE"), rejection)
      .to.params.get("tag")
    expect(createStateless(createRandom(2)).acknowledges(acked(request("ACK"), tag))).toBe(false)
  })
})
