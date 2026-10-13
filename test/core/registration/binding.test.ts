import { describe, expect, it } from "vitest"
import { createResponse, type NameAddr, type TransportAddress } from "../../../src/core"
import {
  createContact,
  defaultRegistrar,
  dialogContact,
  grantedExpiry,
  listsBinding,
  publicAddress,
  publicHost,
  refreshDelay,
} from "../../../src/core/registration/binding"
import { alice, parsedRequest, register } from "../../helpers"

const request = parsedRequest(register)

describe("createContact", () => {
  it.each([
    [alice, "sip:alice@192.0.2.10:5060"],
    [{ ...alice, transport: "TCP" }, "sip:alice@192.0.2.10:5060;transport=tcp"],
    [{ ...alice, transport: "TLS", port: 5061 }, "sips:alice@192.0.2.10:5061"],
    [
      { ...alice, transport: "WS", host: "a1b2.invalid", port: 0 },
      "sip:alice@a1b2.invalid;transport=ws",
    ],
    [
      { ...alice, transport: "WSS", host: "a1b2.invalid", port: 0 },
      "sip:alice@a1b2.invalid;transport=ws",
    ],
    [{ ...alice, host: "fe80::1%en0" }, "sip:alice@[fe80::1]:5060"],
  ] as [TransportAddress, string][])("builds the Contact for %o", (address, uri) => {
    expect(createContact(address, "sip:alice@example.com")).toStrictEqual({
      uri,
      params: new Map(),
    })
  })

  it("keeps parameters inside the user part and leaves out a missing user", () => {
    expect(createContact(alice, "sip:alice;ext=1@example.com").uri).toBe(
      "sip:alice;ext=1@192.0.2.10:5060",
    )
    expect(createContact(alice, "sip:example.com").uri).toBe("sip:192.0.2.10:5060")
  })
})

describe("defaultRegistrar (RFC 3261 §10.2)", () => {
  it.each([
    ["sip:alice@example.com", "sip:example.com"],
    ["SIPS:alice@example.com:5061", "sips:example.com:5061"],
    ["sip:alice@example.com;transport=tcp", "sip:example.com"],
    ["sip:alice@example.com?Subject=x", "sip:example.com"],
    ["sip:example.com", "sip:example.com"],
  ])("derives %s → %s", (aor, registrar) => {
    expect(defaultRegistrar(aor)).toBe(registrar)
  })

  it("has none for addresses of record that are not SIP", () => {
    expect(defaultRegistrar("tel:+4930123456")).toBeUndefined()
  })
})

describe("grantedExpiry (RFC 3261 §10.2.4)", () => {
  const contact = { uri: "sip:alice@192.0.2.10:5060", params: new Map() }
  const binding = (uri: string, expires: string | null) => ({
    uri,
    params: new Map([["expires", expires]]),
  })
  const ok = (contacts: ReturnType<typeof binding>[] | "*", expires?: string) => ({
    ...createResponse(request, 200, "OK", {
      headers: expires === undefined ? [] : [{ name: "Expires", value: expires }],
    }),
    contact: contacts,
  })

  it("prefers the expires parameter of our own binding, ignoring case and URI parameters", () => {
    const response = ok(
      [
        binding("sip:other@192.0.2.99", "60"),
        binding("SIP:alice@192.0.2.10:5060;ob;transport=udp", "1800"),
      ],
      "900",
    )
    expect(grantedExpiry(response, { contact }, 3600)).toBe(1800)
  })

  it("matches a Contact without a user part", () => {
    const anonymous = { uri: "sip:192.0.2.10:5060", params: new Map() }
    const response = ok([
      binding("sip:other@192.0.2.99", "60"),
      binding("sip:192.0.2.10:5060;ob", "90"),
    ])
    expect(grantedExpiry(response, { contact: anonymous }, 3600)).toBe(90)
  })

  it("takes the only binding when the registrar rewrote our Contact", () => {
    expect(
      grantedExpiry(ok([binding("sip:alice@203.0.113.1:49152", "30")]), { contact }, 3600),
    ).toBe(30)
  })

  it("does not take a binding that is being removed for its own", () => {
    const response = ok([binding("sip:a@192.0.2.1", "0"), binding("sip:b@192.0.2.2", "300")])
    expect(grantedExpiry(response, { contact }, 3600)).toBe(300)
  })

  it("takes the soonest expiry when it cannot tell which binding is its own", () => {
    const response = ok([binding("sip:a@192.0.2.1", "600"), binding("tel:+4930123", "60")], "900")
    expect(grantedExpiry(response, { contact }, 3600)).toBe(60)
    const bare = ok([binding("sip:a@192.0.2.1", null), binding("tel:+4930123", null)], "900")
    expect(grantedExpiry(bare, { contact }, 3600)).toBe(900)
  })

  it("never grants more than requested", () => {
    expect(grantedExpiry(ok([binding(contact.uri, "7200")]), { contact }, 3600)).toBe(3600)
  })

  it("caps absurd values at 2^32-1 before comparing", () => {
    expect(
      grantedExpiry(ok([binding(contact.uri, "9".repeat(40))]), { contact }, 4_294_967_295),
    ).toBe(4_294_967_295)
  })

  it.each([
    ["no binding and no Expires", ok([])],
    ["a wildcard Contact", ok("*")],
    ["an expires flag without value", ok([binding(contact.uri, null)])],
    ["a malformed expires", ok([binding(contact.uri, "60abc")], "soon")],
  ])("keeps the requested expiry for %s", (_, response) => {
    expect(grantedExpiry(response, { contact }, 3600)).toBe(3600)
  })
})

describe("refreshDelay", () => {
  it("refreshes between 45 % and 55 % of the granted time", () => {
    expect(refreshDelay(3600, () => 0)).toBe(1_620_000)
    expect(refreshDelay(3600, () => 0.999_999_9)).toBe(1_980_000)
  })

  it("never refreshes more often than every 5 s", () => {
    expect(refreshDelay(1, () => 0.5)).toBe(5000)
  })
})

describe("publicAddress (RFC 3581 §4)", () => {
  const at = (host: string, port = 5060, transport = "UDP") =>
    ({ transport, host, port }) as TransportAddress
  const seen = (params: [string, string][], current = at("192.168.1.10")) => {
    const response = createResponse(request, 200, "OK")
    const [via] = response.via
    if (!via) throw new Error("No Via")
    return publicAddress({ ...response, via: [{ ...via, params: new Map(params) }] }, current)
  }

  it("moves to where the registrar saw us over UDP", () => {
    expect(
      seen([
        ["received", "203.0.113.1"],
        ["rport", "33172"],
      ]),
    ).toStrictEqual(at("203.0.113.1", 33_172))
    expect(
      seen(
        [
          ["received", "192.168.1.5"],
          ["rport", "5070"],
        ],
        at("172.17.0.2"),
      ),
    ).toStrictEqual(at("192.168.1.5", 5070))
  })

  it.each([
    [
      "the same address, however it is spelt",
      [
        ["received", "2001:DB8::0:5"],
        ["rport", "5060"],
      ],
      at("2001:db8::5"),
    ],
    ["no rport", [["received", "203.0.113.1"]], at("192.168.1.10")],
    [
      "port 0",
      [
        ["received", "203.0.113.1"],
        ["rport", "0"],
      ],
      at("192.168.1.10"),
    ],
    [
      "a name instead of an IP",
      [
        ["received", "nat.example"],
        ["rport", "1"],
      ],
      at("192.168.1.10"),
    ],
    [
      "TLS, where the connection carries the calls",
      [
        ["received", "203.0.113.1"],
        ["rport", "1"],
      ],
      at("192.168.1.10", 5060, "TLS"),
    ],
    [
      "a private address seen from a public one",
      [
        ["received", "10.0.0.9"],
        ["rport", "5060"],
      ],
      at("203.0.113.7"),
    ],
    [
      "a private port change",
      [
        ["received", "192.168.1.10"],
        ["rport", "7000"],
      ],
      at("192.168.1.10"),
    ],
  ] as [string, [string, string][], TransportAddress][])(
    "stays put for %s",
    (_, params, current) => {
      expect(seen(params, current)).toBeUndefined()
    },
  )
})

describe("listsBinding", () => {
  const ours = { uri: "sip:alice@203.0.113.1:33172", params: new Map() }
  const ok = (contact: NameAddr[]) => ({ ...createResponse(request, 200, "OK"), contact })

  it("finds our binding, and trusts a registrar that lists none", () => {
    expect(listsBinding(ok([ours]), { contact: ours })).toBe(true)
    expect(listsBinding(ok([]), { contact: ours })).toBe(true)
    expect(listsBinding({ ...ok([]), contact: "*" }, { contact: ours })).toBe(true)
    expect(
      listsBinding(ok([{ uri: "sip:alice@192.168.1.10", params: new Map() }]), { contact: ours }),
    ).toBe(false)
  })
})

describe("bindings over WebSocket", () => {
  const ws: TransportAddress = { transport: "WSS", host: "a1b2c3.invalid", port: 0 }
  const contact = createContact(ws, "sip:alice@example.com")
  const instance = "urn:uuid:1c69d7aa-1bf4-4b38-a169-11d4e05da802"
  const rewritten = (uuid: string, expires: string) => ({
    uri: "sip:alice@198.51.100.7:51234;transport=ws",
    params: new Map([
      ["expires", expires],
      ["+sip.instance", `"<${uuid}>"`],
    ]),
  })
  const ok = (bindings: NameAddr[]) => ({
    ...createResponse(request, 200, "OK"),
    contact: bindings,
  })

  it("adds ;ob to dialog Contacts over WebSocket only", () => {
    expect(dialogContact(contact, ws).uri).toBe("sip:alice@a1b2c3.invalid;transport=ws;ob")
    const udp = createContact(alice, "sip:alice@example.com")
    expect(dialogContact(udp, alice)).toBe(udp)
  })

  it("finds its binding by instance when the registrar rewrote the Contact, as Asterisk does", () => {
    const response = ok([rewritten("urn:uuid:other", "30"), rewritten(instance, "600")])
    expect(grantedExpiry(response, { contact, instance }, 3600)).toBe(600)
    expect(listsBinding(response, { contact, instance })).toBe(true)
    expect(listsBinding(ok([rewritten("urn:uuid:other", "30")]), { contact, instance })).toBe(false)
    expect(grantedExpiry(response, { contact }, 3600)).toBe(30)
  })

  it("learns a public received over WebSocket, whose port says nothing about audio", () => {
    const answer = (received: string, rport: string) => ({
      ...createResponse(request, 200, "OK"),
      via: [
        {
          transport: "WSS",
          host: "a1b2c3.invalid",
          params: new Map([
            ["received", received],
            ["rport", rport],
          ]),
        },
      ],
    })
    expect(publicHost(answer("203.0.113.9", "51234"), ws)).toBe("203.0.113.9")
    expect(publicHost(answer("10.0.0.5", "51234"), ws)).toBeUndefined()
  })
})
