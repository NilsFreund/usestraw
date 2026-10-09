import type { DropReason, PacketRecord } from "./network/types"

export interface TraceStats {
  readonly sent: number
  readonly delivered: number
  readonly undelivered: number
  readonly inFlight: number
  readonly duplicates: number
  readonly corrupted: number
  readonly dropped: Readonly<Record<DropReason, number>>
}

export function traceStats(trace: readonly PacketRecord[]): TraceStats {
  const dropped = { outage: 0, mtu: 0, loss: 0, congestion: 0, nat: 0, unroutable: 0 }
  const counts = { delivered: 0, undelivered: 0, inFlight: 0, duplicates: 0, corrupted: 0 }
  for (const { copies, fates } of trace) {
    const deliveries = fates.flatMap((fate) => (fate.type === "delivered" ? [fate] : []))
    if (fates.length < copies) counts.inFlight++
    else if (deliveries.length > 0) counts.delivered++
    else counts.undelivered++
    counts.duplicates += Math.max(0, deliveries.length - 1)
    counts.corrupted += deliveries.filter((fate) => fate.corrupted).length
    for (const fate of fates) if (fate.type === "dropped") dropped[fate.reason]++
  }
  return { sent: trace.length, ...counts, dropped }
}
