import type { Random } from "../../core/types"
import { createNat, type Nat } from "./nat/nat"
import type { NatOptions } from "./nat/types"

export interface NatSetup extends NatOptions {
  readonly behind?: string
}

export interface Nats {
  add(id: string, setup: NatSetup): void
  has(id: string): boolean
  get(id: string): Nat
  parent(id: string): string | undefined
  at(host: string, parent: string | undefined): string | undefined
  outermost(id: string): string
}

export function createNats(stream: (label: string) => Random): Nats {
  const nats = new Map<string, { readonly nat: Nat; readonly parent: string | undefined }>()
  const byHost = new Map<string, string>()

  function add(id: string, setup: NatSetup): void {
    if (nats.has(id)) throw new Error(`NAT ${id} already exists`)
    if (setup.behind !== undefined) get(setup.behind)
    const key = hostKey(setup.host, setup.behind)
    if (byHost.has(key)) throw new Error(`Public host ${setup.host} is already taken`)
    nats.set(id, { nat: createNat(setup, stream(`nat:${id}`)), parent: setup.behind })
    byHost.set(key, id)
  }

  function entry(id: string) {
    const found = nats.get(id)
    if (!found) throw new Error(`Unknown NAT ${id}`)
    return found
  }

  function get(id: string): Nat {
    return entry(id).nat
  }

  function parent(id: string): string | undefined {
    return entry(id).parent
  }

  function outermost(id: string): string {
    const above = parent(id)
    return above === undefined ? id : outermost(above)
  }

  return {
    add,
    has: (id) => nats.has(id),
    get,
    parent,
    outermost,
    at: (host, above) => byHost.get(hostKey(host, above)),
  }
}

function hostKey(host: string, parent: string | undefined): string {
  return `${parent ?? ""}|${host}`
}
