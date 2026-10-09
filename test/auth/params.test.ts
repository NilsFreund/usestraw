import { describe, expect, it } from "vitest"
import { parseAuthParams } from "../../src/auth/params"

describe("parseAuthParams (RFC 7235 §2.1)", () => {
  it("reads quoted and bare values and lowercases names", () => {
    expect(parseAuthParams('Realm="a b", algorithm=MD5,stale = FALSE')).toStrictEqual(
      new Map([
        ["realm", "a b"],
        ["algorithm", "MD5"],
        ["stale", "FALSE"],
      ]),
    )
  })

  it("unescapes quoted pairs and keeps commas inside quotes", () => {
    expect(parseAuthParams('nonce="a\\"b\\\\c", qop="auth, auth-int"')).toStrictEqual(
      new Map([
        ["nonce", 'a"b\\c'],
        ["qop", "auth, auth-int"],
      ]),
    )
  })

  it("accepts empty quoted values and bare base64 with padding", () => {
    expect(parseAuthParams('opaque="", nonce=YWJj+/==')).toStrictEqual(
      new Map([
        ["opaque", ""],
        ["nonce", "YWJj+/=="],
      ]),
    )
  })

  it("allows tabs around the equals sign", () => {
    expect(parseAuthParams("realm\t=\ta")).toStrictEqual(new Map([["realm", "a"]]))
  })

  it("skips empty list elements", () => {
    expect(parseAuthParams(" , realm=a,, ,nonce=b , ")).toStrictEqual(
      new Map([
        ["realm", "a"],
        ["nonce", "b"],
      ]),
    )
  })

  it("returns an empty map for empty input", () => {
    expect(parseAuthParams("")).toStrictEqual(new Map())
  })

  it.each([
    ["a parameter without value", "realm"],
    ["an empty bare value", "realm="],
    ["a name that is no token", "re@lm=a"],
    ["a duplicate name", "realm=a, REALM=b"],
    ["an unterminated quote", 'realm="a'],
    ["garbage after a quoted value", 'realm="a"b'],
    ["two values without comma", "realm=a nonce=b"],
    ["a quote inside a bare value", 'realm=a"b'],
    ["an escaped NUL", 'realm="a\\\x00"'],
    ["an escaped escape character", 'realm="\\\x1b[31m"'],
    ["a raw DEL in a bare value", "realm=a\x7f"],
  ])("rejects %s", (_, input) => {
    expect(parseAuthParams(input)).toBeUndefined()
  })
})
