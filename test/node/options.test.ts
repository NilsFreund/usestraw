import { describe, expect, it } from "vitest"
import { resolveOptions } from "../../src/node/options"

const resolve = (uri: string, server?: string) =>
  resolveOptions({ uri, ...(server === undefined ? {} : { server }) })

describe("resolveOptions", () => {
  it.each([
    ["sip:alice@example.com", "UDP", "example.com", 5060],
    ["sips:alice@example.com", "TLS", "example.com", 5061],
    ["SIP:alice@example.com:5070", "UDP", "example.com", 5070],
    ["sip:alice@[2001:db8::1]:5070", "UDP", "2001:db8::1", 5070],
    ["sip:alice@192.0.2.1;transport=udp", "UDP", "192.0.2.1", 5060],
    ["sip:alice@example.com;lr;Transport=TLS", "TLS", "example.com", 5061],
    ["sips:alice@example.com;transport=udp", "TLS", "example.com", 5061],
    ["sip:alice;transport=tcp@example.com", "UDP", "example.com", 5060],
  ])("derives the server from %s", (uri, transport, host, port) => {
    expect(resolve(uri).server).toStrictEqual({ transport, host, port })
  })

  it.each([
    ["tls://sip.example.com", "TLS", "sip.example.com", 5061],
    ["TLS://sip.example.com:5062", "TLS", "sip.example.com", 5062],
    ["udp://192.0.2.1", "UDP", "192.0.2.1", 5060],
    ["udp://192.0.2.1:65535", "UDP", "192.0.2.1", 65535],
    ["tls://[::1]:1", "TLS", "::1", 1],
    ["tls://[fe80::1%en0]", "TLS", "fe80::1%en0", 5061],
  ])("uses the server %s", (server, transport, host, port) => {
    expect(resolve("sip:alice@example.com", server).server).toStrictEqual({
      transport,
      host,
      port,
    })
  })

  it("resolves everything the phone needs", () => {
    const signal = new AbortController().signal
    const tls = { ca: "pem" }
    expect(
      resolveOptions({
        uri: "sip:alice@example.com",
        password: "secret",
        server: "tls://[2001:db8::1]",
        expires: 600,
        closeTimeout: 0,
        signal,
        tls,
      }),
    ).toStrictEqual({
      aor: "sip:alice@example.com",
      registrar: "sip:example.com",
      username: "alice",
      server: { transport: "TLS", host: "2001:db8::1", port: 5061 },
      label: "tls://[2001:db8::1]:5061",
      closeTimeout: 0,
      connectTimeout: 10_000,
      credentials: { username: "alice", password: "secret" },
      expires: 600,
      signal,
      tls,
    })
  })

  it("leaves out what was not given and defaults the close timeout", () => {
    expect(resolve("sip:alice@example.com")).toStrictEqual({
      aor: "sip:alice@example.com",
      registrar: "sip:example.com",
      username: "alice",
      server: { transport: "UDP", host: "example.com", port: 5060 },
      label: "udp://example.com:5060",
      closeTimeout: 5000,
      connectTimeout: 10_000,
    })
  })

  it("prefers the given username over the user part of the uri", () => {
    const settings = resolveOptions({
      uri: "sip:+4930123@example.com",
      username: "a1",
      password: "secret",
    })
    expect(settings.username).toBe("a1")
    expect(settings.credentials).toStrictEqual({ username: "a1", password: "secret" })
  })

  it.each([
    "alice",
    "alice@example.com",
    "tel:+4930123456",
    "sip:example.com",
    "sip:@example.com",
    "sip:alice@",
    "sip:alice@exa_mple.com",
    "sip:alice@example.com:0",
    "sip:alice@ example.com",
  ])("refuses the uri %j", (uri) => {
    expect(() => resolve(uri)).toThrow(
      new TypeError(`Invalid uri ${JSON.stringify(uri)}: use sip:user@domain`),
    )
  })

  it("refuses a password in the uri without repeating it", () => {
    expect(() => resolve("sip:alice:secret@example.com")).toThrow(
      new TypeError("Pass the password as password, not in the uri"),
    )
  })

  it.each(["tcp", "ws", ""])("refuses the transport %j", (transport) => {
    const uri = `sip:alice@example.com;transport=${transport}`
    expect(() => resolve(uri)).toThrow(
      new TypeError(
        `Unsupported transport ${JSON.stringify(transport)} in ${JSON.stringify(uri)}: use udp or tls`,
      ),
    )
  })

  it("refuses to send a sips: uri over UDP", () => {
    expect(() => resolve("sips:alice@example.com", "udp://example.com")).toThrow(
      new TypeError('A sips: uri needs a tls:// server, got "udp://example.com"'),
    )
  })

  it.each([
    "sip.example.com",
    "sip:sip.example.com",
    "tcp://sip.example.com",
    "tls://",
    "tls://sip.example.com:0",
    "tls://sip.example.com:65536",
    "tls://sip.example.com:5061/",
    "tls://sip.example.com:x",
    "tls://[::1",
    "tls://exa_mple.com",
    " tls://sip.example.com",
  ])("refuses the server %j", (server) => {
    expect(() => resolve("sip:alice@example.com", server)).toThrow(
      new TypeError(
        `Invalid server ${JSON.stringify(server)}: use udp://host[:port] or tls://host[:port]`,
      ),
    )
  })

  it.each([
    ["a password with a line break", { password: "a\r\nb" }, TypeError],
    ["an expiry of 0", { expires: 0 }, RangeError],
    ["a fractional expiry", { expires: 1.5 }, RangeError],
  ])("refuses %s before connecting", (_, options, type) => {
    expect(() => resolveOptions({ uri: "sip:alice@example.com", ...options })).toThrow(type)
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    "refuses the close timeout %s",
    (closeTimeout) => {
      expect(() => resolveOptions({ uri: "sip:alice@example.com", closeTimeout })).toThrow(
        new RangeError(`Invalid closeTimeout ${JSON.stringify(closeTimeout)}`),
      )
    },
  )

  it("accepts the largest close timeout", () => {
    expect(
      resolveOptions({ uri: "sip:alice@example.com", closeTimeout: 2 ** 31 - 1 }).closeTimeout,
    ).toBe(2 ** 31 - 1)
  })
})
