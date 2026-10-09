import type { Address } from "../../transport/address"

export type DropReason = "outage" | "mtu" | "loss" | "congestion" | "nat" | "unroutable"

export type Hop = "uplink" | "egress" | "internet" | "ingress" | "downlink" | "arrival"

export type Fate =
  | {
      readonly type: "delivered"
      readonly at: number
      readonly host: string
      readonly corrupted: boolean
    }
  | {
      readonly type: "dropped"
      readonly at: number
      readonly reason: DropReason
      readonly hop: Hop
    }

export interface PacketRecord {
  readonly id: number
  readonly sentAt: number
  readonly from: string
  readonly to: string
  readonly size: number
  readonly summary: string
  readonly copies: number
  readonly fates: readonly Fate[]
}

export interface Delivery {
  readonly host: string
  readonly from: Address
  readonly data: Uint8Array
}
