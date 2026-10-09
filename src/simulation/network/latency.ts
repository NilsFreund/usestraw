import type { Random } from "../../core/types"
import { between, gaussian } from "../random"
import type { Latency } from "./conditions"

export function sampleLatency(latency: Latency, random: Random): number {
  switch (latency.kind) {
    case "fixed":
      return latency.ms
    case "uniform":
      return between(random, latency.min, latency.max)
    case "normal":
      return Math.max(0, Math.round(gaussian(random, latency.mean, latency.deviation)))
  }
}
