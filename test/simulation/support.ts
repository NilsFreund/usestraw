import type { Network } from "../../src/simulation/network/network"
import type { Delivery } from "../../src/simulation/network/types"

const MAX_STEPS = 1_000_000

export interface TimedDelivery extends Delivery {
  readonly at: number
}

export function settle(net: Network, until: number = Number.POSITIVE_INFINITY): TimedDelivery[] {
  const deliveries: TimedDelivery[] = []
  let steps = 0
  for (let at = net.nextEvent(); at !== undefined && at <= until; at = net.nextEvent()) {
    if (++steps > MAX_STEPS) throw new Error(`Network did not settle after ${MAX_STEPS} steps`)
    for (const delivery of net.step(at)) deliveries.push({ at, ...delivery })
  }
  return deliveries
}

export function tolerance(rate: number, samples: number): number {
  return 4 * Math.sqrt((rate * (1 - rate)) / samples)
}
