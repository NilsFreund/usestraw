import { describe, expect, it } from "vitest"
import { decode, encode, maskSecrets } from "../../src/recorder/codec"

const text = (value: unknown) => new TextDecoder().decode(value as Uint8Array)
const roundTrip = (data: string) =>
  text((decode(encode({ data: new TextEncoder().encode(data) })) as { data: Uint8Array }).data)

describe("encode and decode", () => {
  it("round-trips Maps, nested values and nulls", () => {
    const value = {
      params: new Map<string, string | null>([
        ["branch", "z9hG4bK1"],
        ["rport", null],
      ]),
      list: [new Map([["a", new Map([["b", 1]])]])],
      plain: { $map: [], other: 1 },
    }
    expect(decode(encode(value))).toStrictEqual(value)
  })

  it("keeps numbers JSON cannot carry", () => {
    const value = {
      a: Number.NaN,
      b: Number.POSITIVE_INFINITY,
      c: Number.NEGATIVE_INFINITY,
      d: -0,
      e: 0.1,
    }
    expect(decode(encode(value))).toStrictEqual(value)
    expect(Object.is((decode(encode({ d: -0 })) as { d: number }).d, -0)).toBe(true)
  })

  it("keeps text bytes readable and exact, including a byte order mark", () => {
    const data = new TextEncoder().encode(
      "\ufeffREGISTER sip:example.com SIP/2.0\r\nTo: Jürgen\r\n\r\n",
    )
    const encoded = encode({ data })
    expect(encoded).toContain('"$text":"')
    expect(decode(encoded)).toStrictEqual({ data })
  })

  it("treats a Node Buffer like the bytes it is", () => {
    const data = Buffer.from("OPTIONS sip:a@b SIP/2.0\r\n\r\n")
    expect(encode({ data })).toBe(encode({ data: new Uint8Array(data) }))
  })

  it("falls back to base64 for bytes that are not UTF-8, also above one chunk", () => {
    const small = new Uint8Array([0xff, 0x00, 0xc3])
    const large = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 7) % 256)
    for (const data of [small, large, new Uint8Array()]) {
      expect(decode(encode({ data }))).toStrictEqual({ data })
    }
    expect(encode({ data: small })).toBe('{"data":{"$base64":"/wDD"}}')
    expect(encode({ data: new Uint8Array() })).toBe('{"data":{"$text":""}}')
  })
})

describe("masking", () => {
  it.each([
    [
      'Authorization: Digest username="a", response="6629fae4", nonce="n1"',
      'Authorization: Digest username="a", response="masked", nonce="n1"',
    ],
    [
      'proxy-authorization: Digest response = 6629fae4, cnonce="c1"',
      'proxy-authorization: Digest response = "masked", cnonce="c1"',
    ],
    [
      'Authentication-Info: rspauth="6629fae4", qop=auth, nc=00000001',
      'Authentication-Info: rspauth="masked", qop=auth, nc=00000001',
    ],
    ["Proxy-Authentication-Info: RSPAUTH=6629fae4", 'Proxy-Authentication-Info: RSPAUTH="masked"'],
    [
      'Authorization: Digest username="a",\r\n response="6629fae4"',
      'Authorization: Digest username="a",\r\n response="masked"',
    ],
  ])("hides the hash in %j", (header, masked) => {
    expect(roundTrip(`SIP/2.0 200 OK\r\n${header}\r\nContent-Length: 0\r\n\r\n`)).toBe(
      `SIP/2.0 200 OK\r\n${masked}\r\nContent-Length: 0\r\n\r\n`,
    )
  })

  it("leaves other headers and the body alone", () => {
    const message = [
      "MESSAGE sip:a@b SIP/2.0",
      'From: <sip:b@c>;tag=1;response="x1"',
      'X-Note: response="keep"',
      "Content-Length: 22",
      "",
      'response="6629fae4" !',
    ].join("\r\n")
    expect(roundTrip(message)).toBe(message)
  })

  it("hides the hash in a binary message without touching the body", () => {
    const head = new TextEncoder().encode(
      'MESSAGE sip:a@b SIP/2.0\r\nAuthorization: Digest response="6629fae4"\r\n\r\n',
    )
    const body = new Uint8Array([0xff, 0xfe, 0x00])
    const data = new Uint8Array([...head, ...body])
    const decoded = decode(encode({ data })) as { data: Uint8Array }
    expect(decoded.data.slice(-3)).toStrictEqual(body)
    expect(new TextDecoder().decode(decoded.data.slice(0, -3))).toContain('response="masked"')
    expect(encode({ data })).not.toContain(btoa("6629fae4"))
  })

  it("hides the hash in parsed headers too", () => {
    const headers = [
      { name: "Authorization", value: 'Digest response="6629fae4"' },
      { name: "proxy-authorization", value: 'Digest response="6629fae4"' },
      { name: "Authentication-Info", value: 'rspauth="6629fae4"' },
      { name: "Proxy-Authentication-Info", value: 'rspauth="6629fae4"' },
      { name: "X-Other", value: 'response="keep"' },
    ]
    expect(decode(encode({ headers }))).toStrictEqual({
      headers: [
        { name: "Authorization", value: 'Digest response="masked"' },
        { name: "proxy-authorization", value: 'Digest response="masked"' },
        { name: "Authentication-Info", value: 'rspauth="masked"' },
        { name: "Proxy-Authentication-Info", value: 'rspauth="masked"' },
        { name: "X-Other", value: 'response="keep"' },
      ],
    })
  })

  it("leaves a body alone even when it looks like a secret header", () => {
    const body = 'Authorization: Digest response="6629fae4"'
    const message = `MESSAGE sip:a@b SIP/2.0\r\nContent-Length: ${body.length}\r\n\r\n${body}`
    expect(roundTrip(message)).toBe(message)
  })

  it("masks error texts that quote a hash", () => {
    expect(maskSecrets('Invalid header "Digest response=\\"6629fae4\\""')).toBe(
      'Invalid header "Digest response="masked"',
    )
  })
})
