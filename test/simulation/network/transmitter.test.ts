import { describe, expect, it } from "vitest"
import { createTransmitter } from "../../../src/simulation/network/transmitter"

describe("createTransmitter", () => {
  it("sends instantly without a bandwidth limit", () => {
    expect(createTransmitter(undefined, undefined).send(1_000_000, 42)).toBe(42)
  })

  it("adds the exact serialization delay from the bandwidth", () => {
    expect(createTransmitter(8_000_000, undefined).send(1000, 0)).toBe(1)
    expect(createTransmitter(1_000_000, undefined).send(1000, 0)).toBe(8)
    expect(createTransmitter(256_000, undefined).send(1000, 0)).toBe(31.25)
  })

  it("queues back-to-back packets", () => {
    const link = createTransmitter(1_000_000, undefined)
    expect([link.send(1000, 0), link.send(1000, 0), link.send(1000, 0)]).toEqual([8, 16, 24])
    expect(link.busyUntil).toBe(24)
  })

  it("starts fresh after the link went idle", () => {
    const link = createTransmitter(1_000_000, undefined)
    link.send(1000, 0)
    expect(link.send(1000, 100)).toBe(108)
  })

  it("drops packets that overflow the buffer", () => {
    const link = createTransmitter(8000, 1500)
    expect(link.send(1000, 0)).toBe(1000)
    expect(link.send(1000, 0)).toBeUndefined()
    expect(link.send(400, 0)).toBe(1400)
  })

  it("does not invent congestion on fast links", () => {
    const link = createTransmitter(1_000_000_000, 64_000)
    expect(link.send(128, 0)).toBe(0.001024)
    expect(link.send(128, 0)).toBe(0.002048)
  })

  it("sends a packet larger than the buffer when the link is idle", () => {
    expect(createTransmitter(8000, 100).send(1000, 0)).toBe(1000)
  })

  it("queues nothing with a zero buffer", () => {
    const link = createTransmitter(8000, 0)
    expect(link.send(100, 0)).toBe(100)
    expect(link.send(100, 0)).toBeUndefined()
    expect(link.send(100, 100)).toBe(200)
  })

  it("never drops without a buffer limit", () => {
    const link = createTransmitter(8000, undefined)
    const departures = Array.from({ length: 50 }, () => link.send(1000, 0))
    expect(departures.at(-1)).toBe(50_000)
  })

  it("continues a queue that was busy before", () => {
    expect(createTransmitter(8000, undefined, 500).send(100, 0)).toBe(600)
  })
})
