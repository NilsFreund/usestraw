import { describe, expect, it } from "vitest"
import { parseChallenge } from "../../src/auth/challenge"
import { computeCredentials } from "../../src/auth/digest"
import { type Offer, resolveOffer } from "../../src/auth/offer"

function offer(value: string): Offer {
  const challenge = parseChallenge(value)
  const resolved = challenge && resolveOffer(challenge)
  if (!resolved) throw new Error(`Unsupported challenge ${value}`)
  return resolved
}

const mufasa = { username: "Mufasa", password: "Circle of Life" }
const get = { method: "GET", uri: "/dir/index.html", body: new Uint8Array() }
const rfc7616 = { cnonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ", nc: 1 }
const nonce7616 = 'nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v"'
const opaque7616 = 'opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"'
const alice = { username: "alice", password: "secret" }
const register = { method: "REGISTER", uri: "sip:example.com", body: new Uint8Array() }
const client = { cnonce: "0a4f113b", nc: 1 }

describe("computeCredentials", () => {
  it.each([
    ["MD5", "8ca523f5e9506fed4657c9700eebdbec"],
    ["SHA-256", "753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"],
  ])("reproduces the RFC 7616 §3.9.1 %s example", (algorithm, response) => {
    const offered = offer(
      `Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=${algorithm}, ${nonce7616}, ${opaque7616}`,
    )
    expect(computeCredentials(offered, mufasa, get, rfc7616)).toStrictEqual({
      username: "Mufasa",
      realm: "http-auth@example.org",
      nonce: "7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v",
      uri: "/dir/index.html",
      response,
      algorithm,
      opaque: "FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS",
      protection: { qop: "auth", nc: "00000001", cnonce: rfc7616.cnonce },
      userhash: false,
    })
  })

  it("reproduces the errata-corrected RFC 7616 §3.9.2 SHA-512-256 example with userhash", () => {
    const offered = offer(
      'Digest realm="api@example.org", qop="auth", algorithm=SHA-512-256, nonce="5TsQWLVdgBdmrQ0XsxbDODV+57QdFR34I9HAbC/RVvkK", opaque="HRPCssKJSGjCrkzDg8OhwpzCiGPChXYjwrI2QmXDnsOS", charset=UTF-8, userhash=true',
    )
    const credentials = computeCredentials(
      offered,
      { username: "J\u00e4s\u00f8n Doe", password: "Secret, or not?" },
      { method: "GET", uri: "/doe.json", body: new Uint8Array() },
      { cnonce: "NTg6RKcb9boFIAS3KrFK9BGeh+iDa/sm6jUMp2wds69v", nc: 1 },
    )
    expect(credentials).toMatchObject({
      username: "793263caabb707a56211940d90411ea4a575adeccb7e360aeb624ed06ece9b0b",
      response: "3798d4131c277846293534c3edc11bd8a5e4cdcbff78b05db9d95eeb1cec68a5",
      userhash: true,
    })
  })

  it("reproduces the RFC 2617 §3.5 example without an algorithm parameter", () => {
    const offered = offer(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    )
    const credentials = computeCredentials(
      offered,
      { username: "Mufasa", password: "Circle Of Life" },
      get,
      { cnonce: "0a4f113b", nc: 1 },
    )
    expect(credentials.response).toBe("6629fae49393a05397450978507c4ef1")
    expect(credentials).not.toHaveProperty("algorithm")
  })

  it.each([
    ["MD5 without qop (RFC 2069)", "algorithm=MD5", "d1d211daa2e0d7f43de25792410f5057", undefined],
    ["MD5-sess", 'algorithm=MD5-sess, qop="auth"', "a1e3d79684932c7d62f1ce20bfc13594", "auth"],
    [
      "SHA-256 without qop as auth (RFC 8760 §2.6)",
      "algorithm=SHA-256",
      "cc10d19d2fd4ed912cd152ce2f1a6034e418cfeb65b6cbc5902a0a25cd08b328",
      "auth",
    ],
    [
      "SHA-512-256-sess",
      'algorithm=SHA-512-256-sess, qop="auth"',
      "09319d3568a7e028cd95539a3e7aed047c19d94733c9f579bf2c21ed28e8ea28",
      "auth",
    ],
  ])("matches hashlib and OpenSSL for %s", (_, params, response, qop) => {
    const offered = offer(`Digest realm="example.com", nonce="abc123", ${params}`)
    const credentials = computeCredentials(offered, alice, register, client)
    expect(credentials.response).toBe(response)
    expect(credentials.protection?.qop).toBe(qop)
  })

  it("hashes the body for auth-int (RFC 8760 §2.6 item 7)", () => {
    const offered = offer(
      'Digest realm="example.com", nonce="abc123", algorithm=SHA-256, qop="auth-int"',
    )
    const body = new TextEncoder().encode("v=0\r\n")
    const credentials = computeCredentials(
      offered,
      alice,
      { ...register, body },
      { ...client, nc: 2 },
    )
    expect(credentials.response).toBe(
      "2377e7f6c743da590dace54274f5fbf98e2aacbba4b7b4c3ecb65be55d40ef3d",
    )
    expect(credentials.protection).toStrictEqual({
      qop: "auth-int",
      nc: "00000002",
      cnonce: "0a4f113b",
    })
  })

  it("leaves out cnonce, nc and qop in RFC 2069 mode", () => {
    const credentials = computeCredentials(
      offer('Digest realm="r", nonce="n"'),
      alice,
      register,
      client,
    )
    expect(credentials).not.toHaveProperty("protection")
  })

  it("keeps an empty opaque (RFC 3261 §20.44)", () => {
    const credentials = computeCredentials(
      offer('Digest realm="r", nonce="n", opaque=""'),
      alice,
      register,
      client,
    )
    expect(credentials.opaque).toBe("")
  })

  it("writes the nonce count as eight hex digits", () => {
    const offered = offer('Digest realm="r", nonce="n", qop="auth"')
    const credentials = computeCredentials(offered, alice, register, { ...client, nc: 0xffffffff })
    expect(credentials.protection?.nc).toBe("ffffffff")
  })

  it.each([0, -1, 1.5, 2 ** 32, Number.NaN])("refuses the nonce count %d (RFC 7616 §3.4)", (nc) => {
    const offered = offer('Digest realm="r", nonce="n", qop="auth"')
    expect(() => computeCredentials(offered, alice, register, { ...client, nc })).toThrow(
      new RangeError(`Invalid nonce count ${nc}`),
    )
  })

  it.each(["", 'a"b', "a\\b", "x y", "\u00e4"])(
    "refuses the cnonce %j (RFC 7616 §3.4)",
    (cnonce) => {
      const offered = offer('Digest realm="r", nonce="n", qop="auth"')
      expect(() => computeCredentials(offered, alice, register, { ...client, cnonce })).toThrow(
        TypeError,
      )
    },
  )
})
