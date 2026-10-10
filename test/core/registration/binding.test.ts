import { describe, expect, it } from "vitest"
import { createResponse, type TransportAddress } from "../../../src"
import {
  createContact,
  defaultRegistrar,
  grantedExpiry,
  refreshDelay,
} from "../../../src/core/registration/binding"
import { alice, parsedRequest, register } from "../../helpers"

const request = parsedRequest(register)

describe("createContact", () => {
  it.each([
    [alice, "sip:alice@192.0.2.10:5060"],
    [{ ...alice, transport: "TCP" }, "sip:alice@192.0.2.10:5060;transport=tcp"],
    [{ ...alice, transport: "TLS", port: 5061 }, "sips:alice@192.0.2.10:5061"],
    [{ ...alice, transport: "WS", port: 80 }, "sip:alice@192.0.2.10:80;transport=ws"],
    [{ ...alice, transport: "WSS", port: 443 }, "sips:alice@192.0.2.10:443;transport=ws"],
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
    expect(grantedExpiry(response, contact, 3600)).toBe(1800)
  })

  it("matches a Contact without a user part", () => {
    const anonymous = { uri: "sip:192.0.2.10:5060", params: new Map() }
    const response = ok([
      binding("sip:other@192.0.2.99", "60"),
      binding("sip:192.0.2.10:5060;ob", "90"),
    ])
    expect(grantedExpiry(response, anonymous, 3600)).toBe(90)
  })

  it("takes the only binding when the registrar rewrote our Contact", () => {
    expect(grantedExpiry(ok([binding("sip:alice@203.0.113.1:49152", "30")]), contact, 3600)).toBe(
      30,
    )
  })

  it("falls back to the Expires header when several foreign bindings, SIP or not, are listed", () => {
    const response = ok([binding("sip:a@192.0.2.1", "60"), binding("tel:+4930123", "60")], "900")
    expect(grantedExpiry(response, contact, 3600)).toBe(900)
  })

  it("never grants more than requested", () => {
    expect(grantedExpiry(ok([binding(contact.uri, "7200")]), contact, 3600)).toBe(3600)
  })

  it("caps absurd values at 2^32-1 before comparing", () => {
    expect(grantedExpiry(ok([binding(contact.uri, "9".repeat(40))]), contact, 4_294_967_295)).toBe(
      4_294_967_295,
    )
  })

  it.each([
    ["no binding and no Expires", ok([])],
    ["a wildcard Contact", ok("*")],
    ["an expires flag without value", ok([binding(contact.uri, null)])],
    ["a malformed expires", ok([binding(contact.uri, "60abc")], "soon")],
  ])("keeps the requested expiry for %s", (_, response) => {
    expect(grantedExpiry(response, contact, 3600)).toBe(3600)
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
