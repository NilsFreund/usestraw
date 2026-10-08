import { describe, expect, it } from "vitest"
import { createNetwork } from "../../src/simulation/network"
import { createRandom } from "../../src/simulation/random"
import { alice, bob } from "../helpers"

const data = new Uint8Array([1])

describe("createNetwork", () => {
  it("delivers packets after a latency within range", () => {
    const network = createNetwork({ random: createRandom(1), latency: [10, 20] })
    const packet = network.send(alice, bob, data, 100)
    expect(packet.deliverAt).toBeGreaterThanOrEqual(110)
    expect(packet.deliverAt).toBeLessThanOrEqual(120)
    expect(network.nextDelivery()).toBe(packet.deliverAt)
    expect(network.deliver(109)).toEqual([])
    expect(network.deliver(120)).toEqual([packet])
    expect(network.nextDelivery()).toBeUndefined()
  })

  it("drops packets according to the loss rate", () => {
    const network = createNetwork({ random: createRandom(1), loss: 1 })
    expect(network.send(alice, bob, data, 0).deliverAt).toBeNull()
    expect(network.nextDelivery()).toBeUndefined()
  })

  it("keeps send order for packets arriving at the same time", () => {
    const network = createNetwork({ random: createRandom(1), latency: [10, 10] })
    const first = network.send(alice, bob, new Uint8Array([1]), 0)
    const second = network.send(bob, alice, new Uint8Array([2]), 0)
    expect(network.deliver(10)).toEqual([first, second])
  })

  it("delivers due packets in arrival order", () => {
    const network = createNetwork({ random: createRandom(5), latency: [1, 100] })
    const packets = Array.from({ length: 20 }, (_, i) => network.send(alice, bob, data, i))
    const delivered = network.deliver(1000).map((packet) => packet.deliverAt ?? 0)
    expect(delivered).toHaveLength(packets.length)
    expect(delivered).toEqual([...delivered].sort((a, b) => a - b))
  })
})
