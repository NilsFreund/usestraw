import type { Address } from "../../transport/address"
import { addressKey } from "./address"
import type { Hosts } from "./hosts"
import type { Nats } from "./nats"

export interface Naming {
  site(id: string): string
  label(to: Address, origin: string | undefined): string
}

export function createNaming(hosts: Hosts, nats: Nats): Naming {
  function site(id: string): string {
    if (hosts.has(id)) {
      const { nat } = hosts.get(id)
      return nat === undefined ? id : nats.outermost(nat)
    }
    if (nats.has(id)) return nats.outermost(id)
    throw new Error(`Unknown host or NAT ${id}`)
  }

  function label(to: Address, origin: string | undefined): string {
    for (let site = origin; site !== undefined; site = nats.parent(site)) {
      const name = hosts.find(to, site)?.id ?? nats.at(to.host, site)
      if (name !== undefined) return name
    }
    return hosts.find(to, undefined)?.id ?? nats.at(to.host, undefined) ?? addressKey(to)
  }

  return { site, label }
}
