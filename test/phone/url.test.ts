import { describe, expect, it } from "vitest"
import { parseConnectionUrl } from "../../src/phone/url"

const SECRET = "S3CRET"

describe("parseConnectionUrl", () => {
  it.each([
    [
      "tls://agent:secret@sip.carrier.example",
      {
        uri: "sip:agent@sip.carrier.example",
        server: "tls://sip.carrier.example",
        user: "agent",
        password: "secret",
      },
    ],
    [
      "UDP://dev:dev@127.0.0.1:5070",
      { uri: "sip:dev@127.0.0.1", server: "udp://127.0.0.1:5070", user: "dev", password: "dev" },
    ],
    [
      "tls://%2B4930123:p%40ss%3Aw%2Fd@[2001:db8::1]:5061",
      {
        uri: "sip:+4930123@[2001:db8::1]",
        server: "tls://[2001:db8::1]:5061",
        user: "+4930123",
        password: "p@ss:w/d",
      },
    ],
    [
      "tls://agent@sip.carrier.example",
      { uri: "sip:agent@sip.carrier.example", server: "tls://sip.carrier.example", user: "agent" },
    ],
  ])("reads %s", (url, fields) => {
    expect(parseConnectionUrl(url)).toStrictEqual(fields)
  })

  it("escapes what a SIP user part cannot carry and keeps the plain user for auth", () => {
    expect(parseConnectionUrl("udp://alice%40corp.example:pw@host.example")).toStrictEqual({
      uri: "sip:alice%40corp.example@host.example",
      server: "udp://host.example",
      user: "alice@corp.example",
      password: "pw",
    })
    expect(parseConnectionUrl("udp://J%C3%BCrgen%20%F0%9F%98%80;x=1@host.example").uri).toBe(
      "sip:J%C3%BCrgen%20%F0%9F%98%80;x=1@host.example",
    )
  })

  it.each([
    ["not a url", ""],
    [`https://agent:${SECRET}@sip.carrier.example`, ' for "sip.carrier.example"'],
    ["tls://sip.carrier.example", ' for "sip.carrier.example"'],
    [`tls://agent:${SECRET}@sip.carrier.example/`, ' for "sip.carrier.example"'],
    [`tls://agent:pw@sip.carrier.example?password=${SECRET}`, ' for "sip.carrier.example"'],
    [`tls://agent:pw@sip.carrier.example#${SECRET}`, ' for "sip.carrier.example"'],
    [`tls://%zz:${SECRET}@sip.carrier.example`, ' for "sip.carrier.example"'],
    [`tls://agent:%zz${SECRET}@sip.carrier.example`, ' for "sip.carrier.example"'],
    [`agent:${SECRET}@sip.carrier.example`, ""],
    [`sip:agent:${SECRET}@sip.carrier.example`, ""],
    [`tls:agent:${SECRET}@sip.carrier.example`, ""],
    [`//agent:${SECRET}@sip.carrier.example`, ""],
    [`"tls://agent:${SECRET}@sip.carrier.example"`, ""],
    [` tls://agent:${SECRET}@sip.carrier.example/`, ' for "sip.carrier.example"'],
    [`tls://agent:${SECRET}`, ""],
    [`tls://agent:pw@sip.carrier.example:${SECRET}`, ""],
  ])("refuses %s without repeating anything secret", (url, where) => {
    expect(() => parseConnectionUrl(url)).toThrow(
      new TypeError(`Invalid connection URL${where}: use tls://user:password@host[:port]`),
    )
  })
})
