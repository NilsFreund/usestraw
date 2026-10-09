import { describe, expect, it } from "vitest"
import { createPortAllocator } from "../../../../src/simulation/network/nat/ports"
import { createRandom } from "../../../../src/simulation/random"

const free = () => false

describe("createPortAllocator", () => {
  it("preserves the internal port when it is free", () => {
    expect(createPortAllocator("preserve", createRandom(1))(5060, free)).toBe(5060)
  })

  it("falls back to sequential ports when the preserved port is taken", () => {
    const allocate = createPortAllocator("preserve", createRandom(1))
    expect(allocate(5060, (port) => port === 5060)).toBe(49152)
  })

  it("hands out sequential ports and skips taken ones", () => {
    const allocate = createPortAllocator("sequential", createRandom(1))
    expect(allocate(5060, free)).toBe(49152)
    expect(allocate(5060, (port) => port === 49153)).toBe(49154)
  })

  it("wraps sequential ports around within the dynamic range", () => {
    const allocate = createPortAllocator("sequential", createRandom(1))
    const ports = Array.from({ length: 16_385 }, () => allocate(5060, free))
    expect(Math.max(...ports)).toBe(65535)
    expect(ports.at(-1)).toBe(49152)
  })

  it.each(["sequential", "random"] as const)("fails clearly when %s ports run out", (strategy) => {
    const allocate = createPortAllocator(strategy, createRandom(1))
    expect(() => allocate(5060, () => true)).toThrow("NAT ran out of ports")
  })

  it("picks random ports in the unprivileged range and skips taken ones", () => {
    const first = createPortAllocator("random", createRandom(7))(5060, free)
    const retried = createPortAllocator("random", createRandom(7))(5060, (port) => port === first)
    expect(first).toBeGreaterThanOrEqual(1024)
    expect(first).toBeLessThanOrEqual(65535)
    expect(retried).not.toBe(first)
  })
})
