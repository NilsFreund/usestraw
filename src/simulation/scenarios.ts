import type { Address } from "../core/types"
import type { Access } from "./network/conditions"
import type { HostOptions } from "./network/hosts"
import type { Simulation } from "./simulation"

export interface Flapping {
  readonly from: number
  readonly every: number
  readonly duration: number
  readonly count: number
}

export function outage(simulation: Simulation, host: string, from: number, duration: number): void {
  simulation.at(from, () => simulation.network.disconnect(host))
  simulation.at(from + duration, () => simulation.network.reconnect(host))
}

export function flapping(simulation: Simulation, host: string, schedule: Flapping): void {
  const { from, every, duration, count } = schedule
  for (let index = 0; index < count; index++) {
    outage(simulation, host, from + index * every, duration)
  }
}

export function partition(
  simulation: Simulation,
  between: readonly [string, string],
  from: number,
  duration: number,
): void {
  const [a, b] = between
  simulation.at(from, () => {
    simulation.network.block(a, b)
    simulation.network.block(b, a)
  })
  simulation.at(from + duration, () => {
    simulation.network.unblock(a, b)
    simulation.network.unblock(b, a)
  })
}

export function handover(
  simulation: Simulation,
  host: string,
  at: number,
  address: Address,
  options?: HostOptions,
): void {
  simulation.at(at, () => simulation.network.move(host, address, options))
}

export function degrade(simulation: Simulation, host: string, at: number, access: Access): void {
  simulation.at(at, () => simulation.network.setAccess(host, access))
}
