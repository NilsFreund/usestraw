import type { Address, Random } from "../../../core/types"
import { endpointKey, mappingKey, portKey } from "./keys"
import { createPortAllocator } from "./ports"
import type { NatOptions } from "./types"

export interface Nat {
  readonly host: string
  outbound(internal: Address, remote: Address, now: number): Address
  inbound(external: Address, remote: Address, now: number): Address | undefined
  reset(): void
}

interface Mapping {
  readonly key: string
  readonly internal: Address
  readonly port: number
  readonly hosts: Set<string>
  readonly endpoints: Set<string>
  lastActive: number
}

export function createNat(options: NatOptions, random: Random): Nat {
  const {
    host,
    mapping = "endpoint-independent",
    filtering = "address-and-port-dependent",
    timeout = 30_000,
    ports = "random",
    refreshOnInbound = false,
  } = options
  const allocate = createPortAllocator(ports, random)
  let byKey = new Map<string, Mapping>()
  let byPort = new Map<string, Mapping>()

  function outbound(internal: Address, remote: Address, now: number): Address {
    const key = mappingKey(mapping, internal, remote)
    const existing = byKey.get(key)
    const entry = existing && alive(existing, now) ? existing : open(key, internal)
    entry.lastActive = now
    entry.hosts.add(remote.host)
    entry.endpoints.add(endpointKey(remote))
    return { transport: internal.transport, host, port: entry.port }
  }

  function inbound(external: Address, remote: Address, now: number): Address | undefined {
    const entry = byPort.get(portKey(external.transport, external.port))
    if (!entry || !alive(entry, now) || !admits(entry, remote)) return undefined
    if (refreshOnInbound) entry.lastActive = now
    return entry.internal
  }

  function open(key: string, internal: Address): Mapping {
    const port = allocate(internal.port, (candidate) =>
      byPort.has(portKey(internal.transport, candidate)),
    )
    const entry = {
      key,
      internal,
      port,
      hosts: new Set<string>(),
      endpoints: new Set<string>(),
      lastActive: 0,
    }
    byKey.set(key, entry)
    byPort.set(portKey(internal.transport, port), entry)
    return entry
  }

  function alive(entry: Mapping, now: number): boolean {
    if (now - entry.lastActive <= timeout) return true
    byKey.delete(entry.key)
    byPort.delete(portKey(entry.internal.transport, entry.port))
    return false
  }

  function admits(entry: Mapping, remote: Address): boolean {
    switch (filtering) {
      case "endpoint-independent":
        return true
      case "address-dependent":
        return entry.hosts.has(remote.host)
      case "address-and-port-dependent":
        return entry.endpoints.has(endpointKey(remote))
    }
  }

  function reset(): void {
    byKey = new Map()
    byPort = new Map()
  }

  return { host, outbound, inbound, reset }
}
