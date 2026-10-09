import type { Random } from "../../core/types"
import { chance } from "../random"
import type { LinkConditions } from "./conditions"
import { corrupt } from "./corruption"
import { sampleLatency } from "./latency"
import { createLossModel } from "./loss"
import { createTransmitter } from "./transmitter"
import type { DropReason } from "./types"
import { validateConditions } from "./validate"

export interface Copy {
  readonly at: number
  readonly data: Uint8Array
  readonly corrupted: boolean
}

export type Traversal =
  | { readonly type: "dropped"; readonly reason: DropReason }
  | { readonly type: "passed"; readonly copies: readonly Copy[] }

export interface Segment {
  readonly conditions: LinkConditions
  traverse(data: Uint8Array, size: number, at: number): Traversal
  retune(conditions: LinkConditions): Segment
}

interface Carried {
  readonly busyUntil: number
  readonly lastExit: number
}

export function createSegment(
  conditions: LinkConditions,
  random: Random,
  carried: Carried = { busyUntil: 0, lastExit: 0 },
): Segment {
  validateConditions(conditions)
  const lost = createLossModel(conditions.loss, random)
  const transmitter = createTransmitter(conditions.bandwidth, conditions.buffer, carried.busyUntil)
  let lastExit = carried.lastExit

  function delay(): number {
    const { latency, spikes } = conditions
    const base = latency ? sampleLatency(latency, random) : 0
    const spike =
      spikes && chance(random, spikes.chance) ? sampleLatency(spikes.latency, random) : 0
    return base + spike
  }

  function exit(sent: number): number {
    const at = sent + delay()
    if (!conditions.ordered) return at
    lastExit = Math.max(lastExit, at)
    return lastExit
  }

  function copy(data: Uint8Array, sent: number): Copy {
    const corrupted = chance(random, conditions.corrupt ?? 0)
    return { at: exit(sent), data: corrupted ? corrupt(data, random) : data, corrupted }
  }

  function traverse(data: Uint8Array, size: number, at: number): Traversal {
    if (conditions.down) return { type: "dropped", reason: "outage" }
    if (conditions.mtu !== undefined && size > conditions.mtu) {
      return { type: "dropped", reason: "mtu" }
    }
    if (lost()) return { type: "dropped", reason: "loss" }
    const sent = transmitter.send(size, at)
    if (sent === undefined) return { type: "dropped", reason: "congestion" }
    const copies = [copy(data, sent)]
    if (chance(random, conditions.duplicate ?? 0)) copies.push(copy(data, sent))
    return { type: "passed", copies }
  }

  function retune(next: LinkConditions): Segment {
    return createSegment(next, random, { busyUntil: transmitter.busyUntil, lastExit })
  }

  return { conditions, traverse, retune }
}
