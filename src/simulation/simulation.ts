import type { Core } from "../core/core"
import { earliest } from "../core/time"
import type { Address, Command, CoreEvent, Output, Random } from "../core/types"
import { createNetwork, type Packet } from "./network"
import { createRandom } from "./random"
import { summarize, type TraceEntry } from "./trace"

export interface SimulationOptions {
  readonly seed: number
  readonly latency?: readonly [min: number, max: number]
  readonly loss?: number
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
  readonly trace: readonly TraceEntry[]
  addNode(name: string, address: Address, create: (random: Random) => Core): SimulationNode
  command(node: SimulationNode, command: Command): void
  run(until?: number): void
}

interface NodeState extends SimulationNode {
  readonly events: CoreEvent[]
}

export function createSimulation(options: SimulationOptions): Simulation {
  const { seed, maxSteps = 100_000, ...conditions } = options
  const random = createRandom(seed)
  const network = createNetwork({ random, ...conditions })
  const nodes = new Map<string, NodeState>()
  const trace: TraceEntry[] = []
  let now = 0

  function addNode(name: string, address: Address, create: (random: Random) => Core): NodeState {
    if (nodes.has(key(address))) throw new Error(`Address ${key(address)} is already taken`)
    const node = { name, address, core: create(createRandom(random() * 2 ** 32)), events: [] }
    nodes.set(key(address), node)
    return node
  }

  function command(node: SimulationNode, command: Command): void {
    const target = nodes.get(key(node.address))
    if (target !== node) throw new Error(`Unknown node ${node.name}`)
    process(target, target.core.handle({ type: "command", command }, now))
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
      for (const packet of network.deliver(now)) receive(packet)
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
    return earliest([network.nextDelivery(), ...deadlines])
  }

  function receive(packet: Packet): void {
    const node = nodes.get(key(packet.to))
    if (!node) return
    process(node, node.core.handle({ type: "receive", data: packet.data, from: packet.from }, now))
  }

  function process(node: NodeState, outputs: Output[]): void {
    for (const output of outputs) {
      if (output.type === "event") {
        node.events.push(output.event)
        continue
      }
      const packet = network.send(node.address, output.to, output.data, now)
      trace.push({
        sentAt: packet.sentAt,
        deliverAt: packet.deliverAt,
        from: node.name,
        to: nodes.get(key(output.to))?.name ?? key(output.to),
        summary: summarize(output.data),
      })
    }
  }

  return {
    get now() {
      return now
    },
    trace,
    addNode,
    command,
    run,
  }
}

function key(address: Address): string {
  return `${address.transport}:${address.host}:${address.port}`
}
