import { describe, expect, it } from "vitest"
import { findAlgorithm } from "../../src/auth/algorithms"

const hex = (name?: string) => findAlgorithm(name)?.hash(new TextEncoder().encode("abc"))

describe("findAlgorithm (RFC 7616 §3.3, RFC 8760 §2.1)", () => {
  it("defaults to MD5", () => {
    expect(hex()).toBe("900150983cd24fb0d6963f7d28e17f72")
    expect(findAlgorithm()).toMatchObject({ name: "MD5", strength: 1, session: false })
  })

  it("ranks the algorithms by strength", () => {
    const strengths = ["MD5", "SHA-256", "SHA-512-256"].map((name) => findAlgorithm(name)?.strength)
    expect(strengths).toStrictEqual([1, 2, 3])
  })

  it("reports the canonical name for any spelling", () => {
    expect(findAlgorithm("sha-512-256-SESS")?.name).toBe("SHA-512-256")
  })

  it.each([
    ["MD5", "900150983cd24fb0d6963f7d28e17f72"],
    ["sha-256", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["SHA-512-256", "53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23"],
  ])("hashes with %s", (name, digest) => {
    expect(hex(name)).toBe(digest)
  })

  it.each(["MD5-sess", "SHA-256-SESS", "sha-512-256-sess"])(
    "knows the session variant %s",
    (name) => {
      expect(findAlgorithm(name)?.session).toBe(true)
    },
  )

  it.each(["SHA-1", "SHA-512", "AKAv1-MD5", "-sess", "", "MD5 ", "\u017fHA-256", "MD5-\u017fess"])(
    "does not know %j",
    (name) => {
      expect(findAlgorithm(name)).toBeUndefined()
    },
  )
})
