import { describe, expect, it } from "vitest"
import { resolveOptions } from "../../src/phone/options"

const SECRET = "S3CRET"
const resolve = (uri: string, server?: string) => resolveOptions({ uri, server })

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
    expect(
      resolveOptions({
        uri: "sip:alice@example.com",
        password: "secret",
        server: "tls://[2001:db8::1]",
        signal,
        tls: { ca: "pem" },
      }),
    ).toStrictEqual({
      aor: "sip:alice@example.com",
      registrar: "sip:example.com",
      username: "alice",
      server: { transport: "TLS", host: "2001:db8::1", port: 5061 },
      label: "tls://[2001:db8::1]:5061",
      closeTimeout: 5000,
      connectTimeout: 10_000,
      trace: true,
      acceptFrom: "server",
      register: true,
      credentials: { username: "alice", password: "secret" },
      signal,
      tls: { ca: "pem" },
    })
  })

  it("treats options set to undefined as not given", () => {
    expect(
      resolveOptions({
        uri: "sip:alice@example.com",
        password: undefined,
        authUser: undefined,
        server: undefined,
        signal: undefined,
        tls: { ca: undefined },
        acceptFrom: undefined,
        register: undefined,
        localPort: undefined,
      }),
    ).toStrictEqual({
      aor: "sip:alice@example.com",
      registrar: "sip:example.com",
      username: "alice",
      server: { transport: "UDP", host: "example.com", port: 5060 },
      label: "udp://example.com:5060",
      closeTimeout: 5000,
      connectTimeout: 10_000,
      trace: true,
      acceptFrom: "server",
      register: true,
    })
  })

  it("logs in as authUser when the provider has a separate auth user", () => {
    const settings = resolveOptions({
      uri: "sip:+4930123@example.com",
      authUser: "a1",
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
  ])("refuses the uri %j", (uri) => {
    const shown = uri.includes("@") ? `…${uri.slice(uri.lastIndexOf("@"))}` : uri
    expect(() => resolve(uri)).toThrow(
      new TypeError(`Invalid uri ${JSON.stringify(shown)}: use sip:user@domain`),
    )
  })

  it("refuses a uri whose domain cannot be a registrar, even with a server", () => {
    expect(() => resolve("sip:a@b@example.com", "udp://example.com")).toThrow(
      new TypeError('Invalid uri "…@example.com": use sip:user@domain'),
    )
  })

  it.each([
    `sip:agent:${SECRET}@example.com`,
    `sip:agent:${SECRET}@exa mple.com`,
    ` sip:agent:${SECRET}@example.com`,
  ])("never repeats a password written into the uri %j", (uri) => {
    expect(() => resolve(uri)).toThrow(TypeError)
    expect(() => resolve(uri)).not.toThrow(SECRET)
  })

  it.each(["tcp", "ws", ""])("refuses the transport %j", (transport) => {
    const uri = `sip:alice@example.com;transport=${transport}`
    expect(() => resolve(uri)).toThrow(
      new TypeError(
        `Unsupported transport ${JSON.stringify(transport)} in "…@example.com;transport=${transport}": use udp or tls`,
      ),
    )
  })

  it("refuses to send a sips: uri over UDP", () => {
    expect(() => resolve("sips:alice@example.com", "udp://example.com")).toThrow(
      new TypeError('A sips: uri needs a tls:// server, got "udp://example.com"'),
    )
  })

  const anyServer = "use udp://host[:port] or tls://host[:port]"
  const range = "the port must be from 1 to 65535"
  it.each([
    ["sip.example.com", "sip.example.com", anyServer],
    ["sip:sip.example.com", "sip:sip.example.com", anyServer],
    ["tcp://sip.example.com", "tcp://sip.example.com", anyServer],
    ["tls://", "tls://", anyServer],
    ["tls://sip.example.com:0", "tls://sip.example.com:…", range],
    ["tls://sip.example.com:65536", "tls://sip.example.com:…", range],
    ["tls://sip.example.com:5061/", "tls://sip.example.com:…", "leave out the path"],
    ["tls://sip.example.com/", "tls://sip.example.com/", "leave out the path"],
    ["tls://sip.example.com:x", "tls://sip.example.com:…", anyServer],
    ["tls://exa_mple.com:5061", "tls://exa_mple.com:…", anyServer],
    ["tls://[::1", "tls://[:…", anyServer],
    ["tls://[::1]:65536", "tls://[::1]:…", range],
    [" tls://sip.example.com", " tls:…", anyServer],
  ])("refuses the server %j, cut after its first colon", (server, shown, hint) => {
    expect(() => resolve("sip:alice@example.com", server)).toThrow(
      new TypeError(`Invalid server ${JSON.stringify(shown)}: ${hint}`),
    )
  })

  it.each([
    [`sip:agent:${SECRET}`, undefined, 'Invalid uri "sip:agent:…"'],
    [`agent:${SECRET}`, undefined, 'Invalid uri "agent:…"'],
    ["sip:agent@example.com", `tls://agent:${SECRET}`, 'Invalid server "tls://agent:…"'],
    [
      "sip:agent@example.com",
      `udp://[2001:db8::1]:${SECRET}`,
      'Invalid server "udp://[2001:db8::1]:…"',
    ],
  ])("never repeats a password written where no host follows: %j %j", (uri, server, shown) => {
    expect(() => resolve(uri, server)).toThrow(shown)
    expect(() => resolve(uri, server)).not.toThrow(SECRET)
  })

  it.each([
    [{ uri: 42 }, "uri must be a string, got 42"],
    [{ uri: undefined }, "uri must be a string, got undefined"],
    [{ uri: null }, "uri must be a string, got null"],
    [{ uri: new URL(`sip:alice:${SECRET}@example.com`) }, "uri must be a string, got URL"],
    [{ uri: Object.create(null) }, "uri must be a string, got an object"],
    [
      { uri: "sip:alice@example.com", server: new String(`tls://alice:${SECRET}@example.com`) },
      "server must be a string, got String",
    ],
  ])(
    "names the type, never the value, of a uri or server that is not text: %j",
    (options, message) => {
      expect(() => resolveOptions(options as never)).toThrow(new TypeError(message))
    },
  )

  it("never repeats credentials pasted into the server", () => {
    expect(() => resolve("sip:agent@example.com", `tls://agent:${SECRET}@example.com`)).toThrow(
      new TypeError('Invalid server "…@example.com": use udp://host[:port] or tls://host[:port]'),
    )
  })

  it("answers only the realm it is given, and checks it like the password", () => {
    const pinned = resolveOptions({
      uri: "sip:alice@example.com",
      password: "pw",
      realm: "example.com",
    })
    expect(pinned.credentials).toStrictEqual({
      username: "alice",
      password: "pw",
      realm: "example.com",
    })
    expect(
      resolveOptions("tls://alice:pw@example.com", { realm: "example.com" }).credentials,
    ).toStrictEqual({ username: "alice", password: "pw", realm: "example.com" })
    expect(() =>
      resolveOptions({ uri: "sip:alice@example.com", password: "pw", realm: "a\r\nb" }),
    ).toThrow(TypeError)
    expect(() =>
      resolveOptions({ uri: "sip:alice@example.com", password: "pw", realm: "" }),
    ).toThrow(new TypeError("realm must not be empty: leave it out instead"))
  })

  it("refuses a password with a line break before connecting", () => {
    expect(() => resolveOptions({ uri: "sip:alice@example.com", password: "a\r\nb" })).toThrow(
      TypeError,
    )
  })

  it.each([undefined, "", "  "])(
    "asks for a connection URL when it got %j, as from an unset or empty variable",
    (url) => {
      expect(() => resolveOptions(url)).toThrow(
        new TypeError(
          "Missing connection URL (is SIP_URL set?): pass tls://user:password@host[:port]",
        ),
      )
    },
  )

  it("reads a connection URL and takes the remaining options beside it", () => {
    const signal = new AbortController().signal
    expect(resolveOptions("tls://agent:secret@sip.carrier.example", { signal })).toStrictEqual({
      aor: "sip:agent@sip.carrier.example",
      registrar: "sip:sip.carrier.example",
      username: "agent",
      server: { transport: "TLS", host: "sip.carrier.example", port: 5061 },
      label: "tls://sip.carrier.example:5061",
      closeTimeout: 5000,
      connectTimeout: 10_000,
      trace: true,
      acceptFrom: "server",
      register: true,
      credentials: { username: "agent", password: "secret" },
      signal,
    })
  })

  it("lets a separate auth user log in for the user in the URL", () => {
    const settings = resolveOptions("udp://+4930123:secret@127.0.0.1:5070", { authUser: "a1" })
    expect(settings.aor).toBe("sip:+4930123@127.0.0.1")
    expect(settings.credentials).toStrictEqual({ username: "a1", password: "secret" })
    expect(settings.server).toStrictEqual({ transport: "UDP", host: "127.0.0.1", port: 5070 })
  })

  it("logs in with the decoded URL user even where the SIP address needs escaping", () => {
    const settings = resolveOptions("tls://alice%40corp.example:pw@sip.carrier.example")
    expect(settings.aor).toBe("sip:alice%40corp.example@sip.carrier.example")
    expect(settings.credentials).toStrictEqual({ username: "alice@corp.example", password: "pw" })
  })

  it("connects without credentials when the URL has no password", () => {
    expect(resolveOptions("udp://dev@127.0.0.1").credentials).toBeUndefined()
  })

  it("takes the password beside a URL so the secret stays out of it", () => {
    expect(resolveOptions("tls://agent@sip.carrier.example", { password: "secret" })).toMatchObject(
      {
        aor: "sip:agent@sip.carrier.example",
        credentials: { username: "agent", password: "secret" },
      },
    )
  })

  it("refuses a password in both places", () => {
    expect(() =>
      resolveOptions("tls://agent:one@sip.carrier.example", { password: "two" }),
    ).toThrow(new TypeError("Pass the password in the URL or as password, not both"))
  })

  it("keeps the URL in charge of where to connect", () => {
    const extra = { uri: "sip:mallory@evil.example", server: "udp://evil.example" }
    const settings = resolveOptions("tls://agent@sip.carrier.example", extra as never)
    expect(settings.aor).toBe("sip:agent@sip.carrier.example")
    expect(settings.label).toBe("tls://sip.carrier.example:5061")
  })

  it("refuses a broken URL without repeating its password", () => {
    expect(() => resolveOptions(`tls://agent:${SECRET}@`)).toThrow(
      new TypeError(
        "Invalid connection URL: use tls://user:password@host[:port], with % # ? / in the password percent-encoded",
      ),
    )
  })

  it("turns the trace off when asked", () => {
    expect(resolveOptions({ uri: "sip:alice@example.com", trace: false }).trace).toBe(false)
    expect(resolveOptions("udp://dev@127.0.0.1", { trace: false }).trace).toBe(false)
  })

  it("lets anyone call only when asked, and refuses other values", () => {
    expect(resolveOptions("udp://dev@127.0.0.1", { acceptFrom: "anyone" }).acceptFrom).toBe(
      "anyone",
    )
    expect(() =>
      resolveOptions("udp://dev@127.0.0.1", { acceptFrom: "everyone" as "anyone" }),
    ).toThrow(
      new TypeError(
        'acceptFrom must be "server", "anyone" or a list of IPs and CIDR ranges, got "everyone"',
      ),
    )
  })

  it("takes a copy of the IPs and ranges that may call besides the server", () => {
    const ranges = ["198.51.100.0/24", "2001:db8::7"]
    const settings = resolveOptions("udp://dev@127.0.0.1", { acceptFrom: ranges })
    ranges.push("0.0.0.0/0")
    expect(settings.acceptFrom).toStrictEqual(["198.51.100.0/24", "2001:db8::7"])
    expect(() =>
      resolveOptions("udp://dev@127.0.0.1", { acceptFrom: ["sip.example.com"] }),
    ).toThrow(
      new TypeError('acceptFrom must list IP addresses or CIDR ranges, got ["sip.example.com"]'),
    )
  })

  it("connects to a trunk without registering, on a fixed local port", () => {
    const settings = resolveOptions("udp://dev@127.0.0.1", { register: false, localPort: 5060 })
    expect(settings).toMatchObject({ register: false, localPort: 5060 })
    expect(() => resolveOptions("udp://dev@127.0.0.1", { register: "no" as never })).toThrow(
      new TypeError('register must be true or false, got "no"'),
    )
  })

  it.each([0, 65_536, 5060.5])("refuses localPort %s", (localPort) => {
    expect(() => resolveOptions("udp://dev@127.0.0.1", { localPort })).toThrow(
      new RangeError(`localPort must be an integer from 1 to 65535, got ${localPort}`),
    )
  })

  it("takes the lowest and highest port", () => {
    expect(resolveOptions("udp://dev@127.0.0.1", { localPort: 1 }).localPort).toBe(1)
    expect(resolveOptions("udp://dev@127.0.0.1", { localPort: 65_535 }).localPort).toBe(65_535)
  })

  it("refuses a fixed port or an acceptFrom list over TLS, where nobody else can call in", () => {
    expect(resolveOptions("tls://dev@127.0.0.1", { register: false }).register).toBe(false)
    expect(resolveOptions("tls://dev@127.0.0.1", { acceptFrom: "anyone" }).acceptFrom).toBe(
      "anyone",
    )
    expect(() => resolveOptions("tls://dev@127.0.0.1", { localPort: 5061 })).toThrow(
      new TypeError("localPort only works with a udp:// server"),
    )
    expect(() => resolveOptions("tls://dev@127.0.0.1", { acceptFrom: ["192.0.2.1"] })).toThrow(
      new TypeError("An acceptFrom list only works with a udp:// server"),
    )
  })

  it("refuses a list with holes", () => {
    // biome-ignore lint/suspicious/noSparseArray: a hole is what this test is about
    const acceptFrom = [, "192.0.2.1"] as string[]
    expect(() => resolveOptions("udp://dev@127.0.0.1", { acceptFrom })).toThrow(
      /^acceptFrom must list IP addresses or CIDR ranges/,
    )
  })
})
