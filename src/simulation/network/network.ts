import { createAgenda } from "../../support/agenda"
import type { Address } from "../../transport/address"
import { createStreams } from "../random"
import type { Access, LinkConditions } from "./conditions"
import { createForwarding, type PacketState, type Transit } from "./forwarding"
import { createHosts, type HostOptions } from "./hosts"
import { createNaming } from "./naming"
import { createNats, type NatSetup } from "./nats"
import { createRoutes } from "./routes"
import { summarize } from "./summary"
import type { Delivery, PacketRecord } from "./types"

export interface NetworkOptions {
  readonly seed: number
  readonly internet?: LinkConditions
}

export interface Network {
  readonly trace: readonly PacketRecord[]
  addNat(id: string, setup: NatSetup): void
  resetNat(id: string): void
  attach(id: string, address: Address, options?: HostOptions): void
  move(id: string, address: Address, options?: HostOptions): void
  setAccess(id: string, access: Access): void
  disconnect(id: string): void
  reconnect(id: string): void
  setRoute(from: string, to: string, conditions?: LinkConditions): void
  block(from: string, to: string): void
  unblock(from: string, to: string): void
  addressOf(id: string): Address
  send(from: string, to: Address, data: Uint8Array, now: number): void
  nextEvent(): number | undefined
  step(now: number): Delivery[]
}

const HEADER_BYTES = 28

export function createNetwork({ seed, internet = {} }: NetworkOptions): Network {
  const stream = createStreams(seed)
  const hosts = createHosts(stream)
  const nats = createNats(stream)
  const routes = createRoutes(internet, stream)
  const agenda = createAgenda<Transit>()
  const advance = createForwarding({ hosts, nats, routes, agenda })
  const { site, label } = createNaming(hosts, nats)
  const trace: PacketState[] = []

  function attach(id: string, address: Address, options: HostOptions = {}): void {
    if (nats.has(id)) throw new Error(`Name ${id} is already taken by a NAT`)
    admit(address, options.nat ?? undefined)
    hosts.add(id, address, options)
  }

  function move(id: string, address: Address, options: HostOptions = {}): void {
    admit(address, options.nat === undefined ? hosts.get(id).nat : (options.nat ?? undefined))
    hosts.move(id, address, options)
  }

  function admit(address: Address, site: string | undefined): void {
    if (site !== undefined) nats.get(site)
    const owner = nats.at(address.host, site)
    if (owner !== undefined) {
      throw new Error(`Host ${address.host} is the public address of NAT ${owner}`)
    }
  }

  function addNat(id: string, setup: NatSetup): void {
    if (hosts.has(id)) throw new Error(`Name ${id} is already taken by a host`)
    if (hosts.uses(setup.host, setup.behind)) {
      throw new Error(`Public host ${setup.host} is already used by a host`)
    }
    nats.add(id, setup)
  }

  function send(from: string, to: Address, data: Uint8Array, now: number): void {
    const { address, nat } = hosts.get(from)
    const packet: PacketState = {
      id: trace.length + 1,
      sentAt: now,
      from,
      to: label(to, nat),
      size: data.length + HEADER_BYTES,
      summary: summarize(data),
      copies: 1,
      fates: [],
    }
    trace.push(packet)
    agenda.push(now, {
      packet,
      sender: from,
      receiver: "",
      source: address,
      destination: to,
      data,
      corrupted: false,
      hop: "uplink",
      origin: nat,
    })
  }

  function step(now: number): Delivery[] {
    const deliveries: Delivery[] = []
    for (let transit = agenda.take(now); transit; transit = agenda.take(now)) {
      const delivery = advance(transit, now)
      if (delivery) deliveries.push(delivery)
    }
    return deliveries
  }

  return {
    trace,
    addNat,
    resetNat: (id) => nats.get(id).reset(),
    attach,
    move,
    setAccess: (id, access) => hosts.setAccess(id, access),
    disconnect: (id) => hosts.disconnect(id),
    reconnect: (id) => hosts.reconnect(id),
    setRoute: (from, to, conditions) => routes.set(site(from), site(to), conditions),
    block: (from, to) => routes.block(site(from), site(to)),
    unblock: (from, to) => routes.unblock(site(from), site(to)),
    addressOf: (id) => hosts.get(id).address,
    send,
    nextEvent: () => agenda.next(),
    step,
  }
}
