import { earliest } from "../core/time"
import type { Address, Random } from "../core/types"
import { between } from "./random"

export interface Packet {
  readonly from: Address
  readonly to: Address
  readonly data: Uint8Array
  readonly sentAt: number
  readonly deliverAt: number | null
}

export interface NetworkOptions {
  readonly random: Random
  readonly latency?: readonly [min: number, max: number]
  readonly loss?: number
}

export interface Network {
  send(from: Address, to: Address, data: Uint8Array, now: number): Packet
  nextDelivery(): number | undefined
  deliver(now: number): Packet[]
}

type Scheduled = Packet & { readonly deliverAt: number }

export function createNetwork({ random, latency = [10, 50], loss = 0 }: NetworkOptions): Network {
  let inFlight: Scheduled[] = []

  function send(from: Address, to: Address, data: Uint8Array, now: number): Packet {
    const lost = random() < loss
    const deliverAt = now + between(random, latency[0], latency[1])
    if (lost) return { from, to, data, sentAt: now, deliverAt: null }
    const packet = { from, to, data, sentAt: now, deliverAt }
    inFlight.push(packet)
    return packet
  }

  function nextDelivery(): number | undefined {
    return earliest(inFlight.map((packet) => packet.deliverAt))
  }

  function deliver(now: number): Packet[] {
    const due: Scheduled[] = []
    const remaining: Scheduled[] = []
    for (const packet of inFlight) (packet.deliverAt <= now ? due : remaining).push(packet)
    inFlight = remaining
    return due.sort((a, b) => a.deliverAt - b.deliverAt)
  }

  return { send, nextDelivery, deliver }
}
