import type { Core } from "../core/core"
import type { Command, CoreEvent, Output, Random } from "../core/types"
import { createAgenda } from "../support/agenda"
import { earliest } from "../support/time"
import type { Address } from "../transport/address"
import type { LinkConditions } from "./network/conditions"
import type { HostOptions } from "./network/hosts"
import { createNetwork, type Network } from "./network/network"
import type { Delivery, PacketRecord } from "./network/types"
import { createRandom, deriveSeed } from "./random"

export interface SimulationOptions {
  readonly seed: number
  readonly internet?: LinkConditions
  readonly maxSteps?: number
}

export interface SimulationNode {
  readonly name: string
  readonly address: Address
  readonly core: Core
  readonly events: readonly CoreEvent[]
}

export interface Simulation {
  readonly now: number
  readonly network: Network
  readonly trace: readonly PacketRecord[]
  addNode(
    name: string,
    address: Address,
    create: (random: Random) => Core,
    options?: HostOptions,
  ): SimulationNode
  command(node: SimulationNode, command: Command): void
  at(time: number, action: () => void): void
  run(until?: number): void
}

interface NodeState extends SimulationNode {
  readonly events: CoreEvent[]
}

export function createSimulation(options: SimulationOptions): Simulation {
  const { seed, maxSteps = 100_000, ...conditions } = options
  const network = createNetwork({ seed, ...conditions })
  const timeline = createAgenda<() => void>()
  const nodes = new Map<string, NodeState>()
  let now = 0

  function addNode(
    name: string,
    address: Address,
    create: (random: Random) => Core,
    hostOptions: HostOptions = {},
  ): NodeState {
    const core = create(createRandom(deriveSeed(seed, `core:${name}`)))
    network.attach(name, address, hostOptions)
    const node: NodeState = {
      name,
      core,
      events: [],
      get address() {
        return network.addressOf(name)
      },
    }
    nodes.set(name, node)
    return node
  }

  function command(node: SimulationNode, command: Command): void {
    const target = nodes.get(node.name)
    if (target !== node) throw new Error(`Unknown node ${node.name}`)
    process(target, target.core.handle({ type: "command", command }, now))
  }

  function at(time: number, action: () => void): void {
    if (time < now) throw new RangeError(`Cannot schedule at ${time}ms, the clock is at ${now}ms`)
    timeline.push(time, action)
  }

  function run(until = Number.POSITIVE_INFINITY): void {
    for (let step = 0; ; step++) {
      const next = nextEvent()
      if (next === undefined || next > until) {
        if (until !== Number.POSITIVE_INFINITY) now = Math.max(now, until)
        return
      }
      if (step === maxSteps) throw new Error(`Simulation did not settle after ${maxSteps} steps`)
      now = Math.max(now, next)
      for (let action = timeline.take(now); action; action = timeline.take(now)) action()
      for (const delivery of network.step(now)) receive(delivery)
      for (const node of nodes.values()) {
        const deadline = node.core.nextDeadline()
        if (deadline !== undefined && deadline <= now) {
          process(node, node.core.handle({ type: "timeout" }, now))
        }
      }
    }
  }

  function nextEvent(): number | undefined {
    const deadlines = Array.from(nodes.values(), (node) => node.core.nextDeadline())
    return earliest([network.nextEvent(), timeline.next(), ...deadlines])
  }

  function receive({ host, from, data }: Delivery): void {
    const node = nodes.get(host)
    if (node) process(node, node.core.handle({ type: "receive", data, from }, now))
  }

  function process(node: NodeState, outputs: Output[]): void {
    for (const output of outputs) {
      if (output.type === "event") node.events.push(output.event)
      else network.send(node.name, output.to, output.data, now)
    }
  }

  return {
    get now() {
      return now
    },
    network,
    trace: network.trace,
    addNode,
    command,
    at,
    run,
  }
}
