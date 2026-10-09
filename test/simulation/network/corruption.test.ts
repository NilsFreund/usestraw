import { describe, expect, it } from "vitest"
import { corrupt } from "../../../src/simulation/network/corruption"
import { createRandom } from "../../../src/simulation/random"
import { bytes } from "../../helpers"

describe("corrupt", () => {
  it("changes exactly one byte of a copy", () => {
    const original = bytes("OPTIONS sip:bob@example.com SIP/2.0")
    const corrupted = corrupt(original, createRandom(1))
    const changed = corrupted.filter((value, index) => value !== original[index])
    expect(changed).toHaveLength(1)
    expect(corrupted).toHaveLength(original.length)
    expect(original).toEqual(bytes("OPTIONS sip:bob@example.com SIP/2.0"))
  })

  it("is deterministic for the same random source", () => {
    const data = bytes("payload")
    expect(corrupt(data, createRandom(5))).toEqual(corrupt(data, createRandom(5)))
  })

  it("copies Node buffers instead of writing into their shared pool", () => {
    const pool = Buffer.from("xxxxOPTIONS sip:bob SIP/2.0")
    const view = pool.subarray(4)
    const corrupted = corrupt(view, createRandom(2))
    expect(pool.toString()).toBe("xxxxOPTIONS sip:bob SIP/2.0")
    expect(corrupted.filter((value, index) => value !== view[index])).toHaveLength(1)
  })

  it("leaves empty data empty", () => {
    expect(corrupt(new Uint8Array(), createRandom(1))).toEqual(new Uint8Array())
  })
})
