import type { Random } from "../../../core/types"
import { between } from "../../random"
import type { PortAllocation } from "./types"

export type PortAllocator = (preferred: number, inUse: (port: number) => boolean) => number

const FIRST_DYNAMIC_PORT = 49152
const LAST_PORT = 65535
const DYNAMIC_PORTS = LAST_PORT - FIRST_DYNAMIC_PORT + 1

export function createPortAllocator(strategy: PortAllocation, random: Random): PortAllocator {
  let next = 0
  function candidate(): number {
    if (strategy === "random") return between(random, 1024, LAST_PORT)
    const port = FIRST_DYNAMIC_PORT + (next % DYNAMIC_PORTS)
    next++
    return port
  }
  return (preferred, inUse) => {
    if (strategy === "preserve" && !inUse(preferred)) return preferred
    for (let attempt = 0; attempt < DYNAMIC_PORTS; attempt++) {
      const port = candidate()
      if (!inUse(port)) return port
    }
    throw new Error("NAT ran out of ports")
  }
}
