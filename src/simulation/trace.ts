import type { Fate, PacketRecord } from "./network/types"

export function describeFate(packet: PacketRecord, fate: Fate): string {
  if (fate.type === "dropped") return fate.reason === "loss" ? "lost" : `dropped: ${fate.reason}`
  const receiver = fate.host === packet.to ? "" : ` at ${fate.host}`
  const corrupted = fate.corrupted ? " corrupted" : ""
  return `+${Math.round(fate.at - packet.sentAt)}ms${receiver}${corrupted}`
}

export function formatTrace(trace: readonly PacketRecord[]): string {
  return trace
    .map((packet) => {
      const fates = packet.fates.map((fate) => describeFate(packet, fate)).join(", ")
      const time = `${String(Math.round(packet.sentAt)).padStart(6)}ms`
      return `${time}  ${packet.from} → ${packet.to}  ${packet.summary}  (${fates || "in flight"})`
    })
    .join("\n")
}
