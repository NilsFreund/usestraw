import { describe, expect, it } from "vitest"
import { type LinkConditions, latency, loss } from "../../../src/simulation/network/conditions"
import { createSegment, type Traversal } from "../../../src/simulation/network/segment"
import { createRandom } from "../../../src/simulation/random"
import { bytes } from "../../helpers"

const data = bytes("INVITE")
const segment = (conditions: LinkConditions, seed = 1) =>
  createSegment(conditions, createRandom(seed))

function exits(result: Traversal): number[] {
  if (result.type === "dropped") throw new Error(`dropped: ${result.reason}`)
  return result.copies.map((copy) => copy.at)
}

describe("createSegment", () => {
  it("passes packets unchanged and instantly on a perfect link", () => {
    expect(segment({}).traverse(data, 100, 7)).toEqual({
      type: "passed",
      copies: [{ at: 7, data, corrupted: false }],
    })
  })

  it("adds latency", () => {
    expect(exits(segment({ latency: latency.fixed(30) }).traverse(data, 100, 10))).toEqual([40])
  })

  it("adds latency spikes on top", () => {
    const spiky = segment({
      latency: latency.fixed(10),
      spikes: { chance: 1, latency: latency.fixed(100) },
    })
    expect(exits(spiky.traverse(data, 100, 0))).toEqual([110])
  })

  it.each<[LinkConditions, string, number]>([
    [{ down: true }, "outage", 100],
    [{ mtu: 1400 }, "mtu", 1401],
    [{ loss: loss.random(1) }, "loss", 100],
    [{ down: true, mtu: 1400, loss: loss.random(1) }, "outage", 1401],
    [{ mtu: 1400, loss: loss.random(1) }, "mtu", 1401],
  ])("drops with %o as %s", (conditions, reason, size) => {
    expect(segment(conditions).traverse(data, size, 0)).toEqual({ type: "dropped", reason })
  })

  it("loses packets before they take up the queue", () => {
    const link = segment({ bandwidth: 8000, buffer: 1500, loss: loss.random(1) })
    expect(link.traverse(data, 1000, 0)).toEqual({ type: "dropped", reason: "loss" })
    expect(link.traverse(data, 1000, 0)).toEqual({ type: "dropped", reason: "loss" })
    expect(exits(link.retune({ bandwidth: 8000 }).traverse(data, 1000, 0))).toEqual([1000])
  })

  it("lets packets of exactly the MTU through", () => {
    expect(segment({ mtu: 1400 }).traverse(data, 1400, 0).type).toBe("passed")
  })

  it("drops on congestion when the buffer overflows", () => {
    const link = segment({ bandwidth: 8000, buffer: 1500 })
    expect(link.traverse(data, 1000, 0).type).toBe("passed")
    expect(link.traverse(data, 1000, 0)).toEqual({ type: "dropped", reason: "congestion" })
  })

  it("duplicates packets with a delay of their own", () => {
    const result = segment({ duplicate: 1, latency: latency.uniform(0, 50) }).traverse(data, 100, 0)
    expect(new Set(exits(result)).size).toBe(2)
  })

  it("corrupts packets and marks them", () => {
    const result = segment({ corrupt: 1 }).traverse(data, 100, 0)
    if (result.type !== "passed") throw new Error("expected a copy")
    const [copy] = result.copies
    expect(copy?.corrupted).toBe(true)
    expect(copy?.data).not.toEqual(data)
  })

  it("reorders packets with jitter unless the link is ordered", () => {
    const send = (conditions: LinkConditions) => {
      const link = segment({ latency: latency.uniform(0, 100), ...conditions }, 3)
      return Array.from(
        { length: 200 },
        (_, index) => exits(link.traverse(data, 100, index))[0] ?? 0,
      )
    }
    const sorted = (values: number[]) =>
      values.every((value, index) => index === 0 || value >= (values[index - 1] ?? 0))
    expect(sorted(send({}))).toBe(false)
    expect(sorted(send({ ordered: true }))).toBe(true)
  })

  it("keeps the queue when retuned", () => {
    const link = segment({ bandwidth: 8000 })
    link.traverse(data, 1000, 0)
    expect(exits(link.retune({ bandwidth: 8000 }).traverse(data, 1000, 0))).toEqual([2000])
  })

  it("keeps packets in order across a retune", () => {
    const link = segment({ ordered: true, latency: latency.fixed(500) })
    expect(exits(link.traverse(data, 100, 0))).toEqual([500])
    expect(exits(link.retune({ ordered: true }).traverse(data, 100, 10))).toEqual([500])
  })

  it("validates retuned conditions", () => {
    expect(() => segment({}).retune({ mtu: 0 })).toThrow(RangeError)
  })

  it("validates its conditions", () => {
    expect(() => segment({ loss: loss.random(2) })).toThrow(RangeError)
  })

  it("exposes its conditions", () => {
    const conditions = { latency: latency.fixed(1) }
    expect(segment(conditions).conditions).toBe(conditions)
  })
})
