import type { Address, Random } from "../../core/types"
import { addressKey } from "./address"
import { type Access, accessLink } from "./conditions"
import { createCounter } from "./counter"
import { createSegment, type Segment } from "./segment"

export interface HostOptions {
  readonly access?: Access
  readonly nat?: string | null
}

export interface Host {
  readonly id: string
  readonly address: Address
  readonly nat: string | undefined
  readonly up: Segment
  readonly down: Segment
  readonly offline: boolean
}

export interface Hosts {
  add(id: string, address: Address, options: HostOptions): void
  move(id: string, address: Address, options: HostOptions): void
  setAccess(id: string, access: Access): void
  disconnect(id: string): void
  reconnect(id: string): void
  has(id: string): boolean
  get(id: string): Host
  find(address: Address, nat: string | undefined): Host | undefined
  uses(ip: string, nat: string | undefined): boolean
}

interface HostState extends Host {
  address: Address
  nat: string | undefined
  up: Segment
  down: Segment
  outages: number
}

export function createHosts(stream: (label: string) => Random): Hosts {
  const hosts = new Map<string, HostState>()
  const index = new Map<string, string>()
  const ips = createCounter()

  function add(id: string, address: Address, options: HostOptions): void {
    if (hosts.has(id)) throw new Error(`Host ${id} already exists`)
    const { up, down } = accessLink(options.access ?? {})
    const links = {
      up: createSegment(up, stream(`up:${id}`)),
      down: createSegment(down, stream(`down:${id}`)),
    }
    const nat = options.nat ?? undefined
    claim(id, address, nat)
    hosts.set(id, {
      id,
      address,
      nat,
      ...links,
      outages: 0,
      get offline() {
        return this.outages > 0
      },
    })
  }

  function move(id: string, address: Address, options: HostOptions): void {
    const host = get(id)
    const nat = options.nat === undefined ? host.nat : (options.nat ?? undefined)
    const links = options.access ? retuned(host, options.access) : host
    const previous = key(host.address, host.nat)
    claim(id, address, nat)
    if (previous !== key(address, nat)) release(host.address, host.nat)
    Object.assign(host, { address, nat, up: links.up, down: links.down })
  }

  function setAccess(id: string, access: Access): void {
    const host = get(id)
    Object.assign(host, retuned(host, access))
  }

  function retuned(host: HostState, access: Access): Pick<Host, "up" | "down"> {
    const { up, down } = accessLink(access)
    return { up: host.up.retune(up), down: host.down.retune(down) }
  }

  function get(id: string): HostState {
    const host = hosts.get(id)
    if (!host) throw new Error(`Unknown host ${id}`)
    return host
  }

  function find(address: Address, nat: string | undefined): Host | undefined {
    const id = index.get(key(address, nat))
    return id === undefined ? undefined : hosts.get(id)
  }

  function claim(id: string, address: Address, nat: string | undefined): void {
    const taken = index.get(key(address, nat))
    if (taken !== undefined && taken !== id) {
      throw new Error(`Address ${addressKey(address)} is already taken by ${taken}`)
    }
    if (taken === id) return
    index.set(key(address, nat), id)
    ips.add(ipKey(address.host, nat))
  }

  function release(address: Address, nat: string | undefined): void {
    index.delete(key(address, nat))
    ips.remove(ipKey(address.host, nat))
  }

  return {
    add,
    move,
    setAccess,
    disconnect: (id) => {
      get(id).outages++
    },
    reconnect: (id) => {
      const host = get(id)
      host.outages = Math.max(0, host.outages - 1)
    },
    has: (id) => hosts.has(id),
    get,
    find,
    uses: (ip, nat) => ips.has(ipKey(ip, nat)),
  }
}

function key(address: Address, nat: string | undefined): string {
  return `${nat ?? ""}|${addressKey(address)}`
}

function ipKey(ip: string, nat: string | undefined): string {
  return `${nat ?? ""}|${ip}`
}
